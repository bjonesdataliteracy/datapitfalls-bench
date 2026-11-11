// Runs the benchmark (PRD 2, B5 to B9): for each month, build the as-of
// database, ask every question under every memory setup, then let each setup
// carry its memory forward. Spending is capped, and everything needed to
// reproduce or score a run is written to the run folder.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  systemPrompt,
  userPrompt,
  type AgentAdapter,
  type AgentResult,
  type AgentTask,
} from './agent.js';
import { estimateTokens } from './adapters/scripted.js';
import { contextFor, loadTimeline, renderContext, type ContextMode } from './context.js';
import type { MemorySetup, SessionInfo, SetupName } from './memory.js';
import { addMonths, monthIndex, monthRange } from './months.js';
import { addUsage, costUsd, NO_USAGE, type Usage } from './pricing.js';
import { instantiate, loadQuestionSet, type QuestionInstance } from './questions.js';
import { dataSpan, materializeAsOf, openAsOfView } from './replay.js';
import type { SessionRecord } from './scorer.js';
import { createSqlTool } from './sql-tool.js';
import { loadTrapWindows } from './traps.js';

export interface RunConfig {
  /** The full bench database. Never modified. */
  db: string;
  /** First and last data month of the replay. */
  from: string;
  to: string;
  setups: SetupName[];
  /** Folder for this run's outputs. */
  outDir: string;
  /** Hard cap on estimated spend, in USD. The run stops when it is reached. */
  budgetUsd: number;
  questionsFile: string;
  catalogFile: string;
  timelineFile: string;
  contextMode?: ContextMode;
  /** Ask only these questions (for small trial runs). */
  questionIds?: string[];
  /** Most model requests per session. */
  maxSteps?: number;
  /** Sessions run at once within a month. */
  concurrency?: number;
  /** Recorded with results and used for the harness's own random choices. */
  seed?: number;
  /** Keep each month's as-of database after use (they are large). */
  keepAsOfDatabases?: boolean;
  /** Free-form facts recorded in config.json: versions, model ids, effort. */
  recorded?: Record<string, unknown>;
}

export interface RunDeps {
  /** Builds the agent. Scripted agents need the answer key, so it is passed in. */
  createAgent(key: GoldKey): AgentAdapter;
  createSetup(name: SetupName): MemorySetup;
  log?(line: string): void;
}

export interface GoldKey {
  current(asOf: string, questionId: string): QuestionInstance | undefined;
  previous(asOf: string, questionId: string): QuestionInstance | undefined;
}

export interface RunSummary {
  outDir: string;
  sessions: number;
  spentUsd: number;
  stoppedForBudget: boolean;
  months: string[];
  /** Estimated tokens in the first request of a session, averaged per setup. */
  promptTokensPerSession: Record<string, number>;
}

/** Gold and trap answers for every month of the run, plus the month before it. */
export function computeGold(
  config: Pick<RunConfig, 'db' | 'from' | 'to' | 'questionsFile' | 'catalogFile' | 'questionIds'>,
  log: (line: string) => void = () => undefined
): Record<string, QuestionInstance[]> {
  const set = loadQuestionSet(config.questionsFile);
  if (config.questionIds) {
    const wanted = new Set(config.questionIds);
    set.questions = set.questions.filter((q) => wanted.has(q.id));
    if (set.questions.length !== wanted.size) throw new Error('Unknown question id in questionIds');
  }
  const windows = loadTrapWindows(config.catalogFile);
  const months = monthRange(config.from, config.to);
  const before = addMonths(config.from, -1);
  const probe = openAsOfView(config.db, config.from);
  const hasBefore = monthIndex(before) >= dataSpan(probe).from;
  probe.close();
  const gold: Record<string, QuestionInstance[]> = {};
  for (const month of hasBefore ? [before, ...months] : months) {
    const db = openAsOfView(config.db, month);
    const result = instantiate(set, db, month, windows);
    db.close();
    if (result.skipped.length) {
      throw new Error(`No gold answer in ${month} for: ${result.skipped.join(', ')}`);
    }
    gold[month] = result.questions;
    log(`gold answers computed for ${month}`);
  }
  return gold;
}

export function goldKey(gold: Record<string, QuestionInstance[]>): GoldKey {
  const find = (month: string, id: string): QuestionInstance | undefined =>
    gold[month]?.find((q) => q.id === id);
  return {
    current: find,
    previous: (asOf, id) => find(addMonths(asOf, -1), id),
  };
}

async function pool<T, R>(
  items: T[],
  size: number,
  work: (item: T) => Promise<R | null>
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
  return results;
}

export async function runBenchmark(config: RunConfig, deps: RunDeps): Promise<RunSummary> {
  const log = deps.log ?? (() => undefined);
  if (!(config.budgetUsd > 0)) throw new Error('A budget above zero is required (budgetUsd).');
  if (existsSync(join(config.outDir, 'sessions.jsonl'))) {
    throw new Error(`${config.outDir} already holds a run. Choose a new folder.`);
  }
  mkdirSync(join(config.outDir, 'asof'), { recursive: true });
  const months = monthRange(config.from, config.to);
  const set = loadQuestionSet(config.questionsFile);
  const timeline = loadTimeline(config.timelineFile, set.standards);
  const mode = config.contextMode ?? 'announce-once';

  const gold = computeGold(config, log);
  const key = goldKey(gold);
  const agent = deps.createAgent(key);
  const setups = config.setups.map((name) => deps.createSetup(name));

  writeFileSync(
    join(config.outDir, 'config.json'),
    JSON.stringify(
      {
        ...config,
        contextMode: mode,
        agent: agent.name,
        model: agent.model,
        questions: (gold[config.from] ?? []).length,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  // The answer key lives beside the run for scoring. It is never shown to an agent.
  writeFileSync(join(config.outDir, 'gold.json'), JSON.stringify(gold));

  let spentUsd = 0;
  let sessions = 0;
  let stoppedForBudget = false;
  const promptTokens: Record<string, { total: number; n: number }> = {};
  const sessionsFile = join(config.outDir, 'sessions.jsonl');
  const charge = (model: string, usage: Usage): void => {
    if (model !== 'none') spentUsd += costUsd(model, usage);
  };

  for (const month of months) {
    if (stoppedForBudget) break;
    const asOfPath = join(config.outDir, 'asof', `asof-${month}.db`);
    materializeAsOf(config.db, month, asOfPath);
    const runSql = createSqlTool(asOfPath);
    const context = renderContext(contextFor(timeline, month, config.from, mode));
    const questions = gold[month] ?? [];

    for (const setup of setups) {
      const jobs = questions.map((q) => {
        const info: SessionInfo = {
          sessionId: `${setup.name}-${month}-${q.id}`,
          asOf: month,
          questionId: q.id,
          question: q.text,
          context,
        };
        const task: AgentTask = {
          sessionId: info.sessionId,
          asOf: month,
          questionId: q.id,
          question: q.text,
          answer: { type: q.answer.type, unit: q.answer.unit },
          context,
          memory: setup.beforeSession(info),
          memoryInstructions: setup.instructions,
          canRemember: setup.canRemember,
          runSql,
          maxSteps: config.maxSteps ?? 12,
        };
        return { info, task };
      });

      const results = await pool(
        jobs,
        config.concurrency ?? 4,
        async ({ task }): Promise<AgentResult | null> => {
          if (spentUsd >= config.budgetUsd) {
            stoppedForBudget = true;
            return null;
          }
          const result = await agent.answer(task);
          charge(agent.model, result.usage);
          return result;
        }
      );

      // Results are applied in question order, so memory does not depend on timing.
      jobs.forEach(({ info, task }, i) => {
        const result = results[i];
        if (!result) return;
        sessions += 1;
        setup.afterSession(info, result);
        const prompt = userPrompt(task);
        const size = estimateTokens(systemPrompt(task) + prompt.stable + prompt.question);
        const tally = (promptTokens[setup.name] ??= { total: 0, n: 0 });
        tally.total += size;
        tally.n += 1;
        const record: SessionRecord = {
          setup: setup.name,
          asOf: month,
          questionId: info.questionId,
          answer: result.answer,
          usage: result.usage,
          memoryTokens: estimateTokens(task.memory),
          steps: result.steps,
          ...(result.error ? { error: result.error } : {}),
        };
        appendFileSync(
          sessionsFile,
          `${JSON.stringify({ ...record, explanation: result.explanation, promptTokensEstimate: size, sqlErrors: result.sqlErrors, notes: result.notes.length, transcript: result.transcript })}\n`
        );
      });
      if (stoppedForBudget) break;

      const night = await setup.nightly(month);
      if (night.model) charge(night.model, night.usage);
      const folder = join(config.outDir, 'memory', setup.name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, `${month}.json`),
        JSON.stringify(
          { size: setup.size(), nightlyUsage: night.usage, memory: setup.snapshot() },
          null,
          2
        )
      );
      log(`${month} ${setup.name}: ${jobs.length} sessions, spent so far $${spentUsd.toFixed(2)}`);
    }
    if (!config.keepAsOfDatabases) rmSync(asOfPath, { force: true });
  }

  const summary: RunSummary = {
    outDir: config.outDir,
    sessions,
    spentUsd,
    stoppedForBudget,
    months,
    promptTokensPerSession: Object.fromEntries(
      Object.entries(promptTokens).map(([name, t]) => [name, Math.round(t.total / t.n)])
    ),
  };
  writeFileSync(join(config.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

/** Read a finished (or budget-stopped) run back for scoring. */
export function readRun(outDir: string): {
  sessions: SessionRecord[];
  gold: Record<string, QuestionInstance[]>;
} {
  const lines = readFileSync(join(outDir, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean);
  const sessions = lines.map((line) => {
    const s = JSON.parse(line) as SessionRecord & { usage?: Usage };
    return { ...s, usage: s.usage ?? NO_USAGE };
  });
  const gold = JSON.parse(readFileSync(join(outDir, 'gold.json'), 'utf8')) as Record<
    string,
    QuestionInstance[]
  >;
  return { sessions, gold };
}

export interface CostAssumptions {
  /** Model requests per session. */
  steps: number;
  /** Tokens the model writes per request, thinking included. */
  outputTokensPerStep: number;
  /** Tokens added to the conversation per step by a query and its result. */
  addedTokensPerStep: number;
}

/**
 * A rough cost for one session from its opening prompt size. Every request
 * re-sends the conversation so far; the opening prompt is assumed cached after
 * the first request. This is arithmetic on assumptions, not a measurement:
 * replace it with real usage from a small live run before trusting it.
 */
export function estimateSessionCost(
  model: string,
  promptTokens: number,
  a: CostAssumptions
): number {
  // Short prompts are below the smallest cacheable size and are billed in full each time.
  const cached = promptTokens >= 4096;
  let usage = NO_USAGE;
  for (let step = 0; step < a.steps; step++) {
    const grown = step * (a.addedTokensPerStep + a.outputTokensPerStep);
    usage = addUsage(usage, {
      inputTokens: grown + (cached ? 0 : promptTokens),
      outputTokens: a.outputTokensPerStep,
      cacheReadTokens: cached && step > 0 ? promptTokens : 0,
      cacheWriteTokens: cached && step === 0 ? promptTokens : 0,
    });
  }
  return costUsd(model, usage);
}
