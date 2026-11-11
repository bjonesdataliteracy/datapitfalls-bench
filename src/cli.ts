#!/usr/bin/env node
// datapitfalls-bench command line. Run with no arguments for usage.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter, DEFAULT_CLAUDE_MODEL, type Effort } from './adapters/claude.js';
import { createScriptedAdapter, type Script } from './adapters/scripted.js';
import type { ContextMode } from './context.js';
import { SETUP_NAMES, type SetupName } from './memory.js';
import { monthRange } from './months.js';
import { PRICES } from './pricing.js';
import { instantiate, loadQuestionSet } from './questions.js';
import { materializeAsOf, newestVisibleMonth, openAsOfView } from './replay.js';
import { estimateSessionCost, readRun, runBenchmark, type CostAssumptions } from './runner.js';
import { compareSetups, metricsCsv, scoreSession, summarizeBySetup } from './scorer.js';
import { benchApiKey, createSetupFactory, loadTaxonomy } from './setup-factory.js';
import { loadTrapWindows } from './traps.js';

const USAGE = `datapitfalls-bench

  asof       --db <bench.db> --as-of YYYY-MM --out <file> [--no-vacuum]
             Write a copy of the database holding only data published by that month.
  questions  --db <bench.db> --as-of YYYY-MM [--json <file>]
             Print every question for that month with its gold answer.
  check      --db <bench.db> --from YYYY-MM --to YYYY-MM [--json <file>]
             Ask every question in every month and report gaps and active traps.
  run        --db <bench.db> --from YYYY-MM --to YYYY-MM --out <folder> --budget <usd>
             [--setups none,log-all,cache,pitfall,debrief] [--model <id>] [--effort medium]
             [--review-model <id>] [--max-reviews 12] [--context-mode announce-once|always|never]
             [--only id1,id2] [--max-steps 12] [--concurrency 4] [--seed 1] [--keep-asof]
             Run the benchmark. THIS CALLS A PAID API and stops at --budget.
             --dry-run runs the whole harness with a scripted agent, spends nothing,
             and prints prompt sizes with a rough cost per session.
             --agent oracle|naive|stale runs a scripted agent (also free).
  score      --run <folder> [--seed 1]
             Score a run: metrics.json, metrics.csv and the gate comparisons.

  Months are data months. Pass --simulated YYYY-MM in place of --as-of to give the
  analyst's calendar month; the newest visible data is then --lag months earlier (default 3).
  --questions <file> and --traps <file> select the question file and trap catalog
  (defaults: questions/questions.yaml and traps/catalog.yaml).

  Gold answers are for scoring. Never show this output to an agent under test.`;

function parseArgs(argv: string[]): { command?: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), 'true');
    else {
      flags.set(arg.slice(2), next);
      i++;
    }
  }
  return { command, flags };
}

function need(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value || value === 'true') throw new Error(`Missing --${name}`);
  return value;
}

function asOfMonth(flags: Map<string, string>): string {
  if (flags.has('simulated')) {
    const lag = flags.has('lag') ? Number(need(flags, 'lag')) : undefined;
    return newestVisibleMonth(need(flags, 'simulated'), lag);
  }
  return need(flags, 'as-of');
}

function questionFile(flags: Map<string, string>): string {
  const fallback = fileURLToPath(new URL('../questions/questions.yaml', import.meta.url));
  return flags.get('questions') ?? fallback;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (!command || command === 'help' || flags.has('help')) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === 'score') return score(flags);
  const dbPath = need(flags, 'db');
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  if (command === 'run') return run(flags, dbPath);

  if (command === 'asof') {
    const asOf = asOfMonth(flags);
    const out = need(flags, 'out');
    const kept = materializeAsOf(dbPath, asOf, out, { vacuum: !flags.has('no-vacuum') });
    console.log(`As of ${asOf} -> ${out}`);
    for (const [table, n] of Object.entries(kept)) console.log(`  ${table}: ${n} rows`);
    return 0;
  }

  const set = loadQuestionSet(questionFile(flags));
  const windows = loadTrapWindows(
    flags.get('traps') ?? fileURLToPath(new URL('../traps/catalog.yaml', import.meta.url))
  );

  if (command === 'questions') {
    const asOf = asOfMonth(flags);
    const db = openAsOfView(dbPath, asOf);
    const result = instantiate(set, db, asOf, windows);
    db.close();
    for (const q of result.questions) {
      const gold = Array.isArray(q.gold.value) ? q.gold.value.join(', ') : q.gold.value;
      console.log(`\n[${q.id}] ${q.text}`);
      console.log(`  gold: ${gold}${q.answer.unit ? ` (${q.answer.unit})` : ''}`);
      for (const trap of q.traps) {
        const fallen = Array.isArray(trap.value) ? trap.value.join(', ') : trap.value;
        const state = trap.active
          ? 'active'
          : trap.differs
            ? 'differs, outside the trap window'
            : 'same as gold';
        console.log(`  trap ${trap.id}: ${fallen} (${state})`);
      }
    }
    if (result.skipped.length)
      console.log(`\nNot askable this month: ${result.skipped.join(', ')}`);
    if (flags.has('json')) writeFileSync(need(flags, 'json'), JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === 'check') {
    const months = monthRange(need(flags, 'from'), need(flags, 'to'));
    const skipped = new Map<string, string[]>();
    const active = new Map<string, string[]>();
    const changes = new Map<string, number>();
    const last = new Map<string, string>();
    const all = [];
    for (const asOf of months) {
      const db = openAsOfView(dbPath, asOf);
      const result = instantiate(set, db, asOf, windows);
      db.close();
      all.push(result);
      for (const id of result.skipped) skipped.set(id, [...(skipped.get(id) ?? []), asOf]);
      for (const q of result.questions) {
        const key = JSON.stringify(q.gold.value);
        if (last.has(q.id) && last.get(q.id) !== key)
          changes.set(q.id, (changes.get(q.id) ?? 0) + 1);
        last.set(q.id, key);
        for (const trap of q.traps) {
          if (trap.active) {
            const label = `${q.id} / ${trap.id}`;
            active.set(label, [...(active.get(label) ?? []), asOf]);
          }
        }
      }
    }
    const adjacent = set.questions.filter((q) => q.traps.length).length;
    console.log(
      `${set.questions.length} questions (${adjacent} trap-adjacent) x ${months.length} months`
    );
    console.log(
      '\nActive traps (months inside the trap window where falling in gives a wrong answer):'
    );
    for (const q of set.questions) {
      for (const trap of q.traps) {
        const hit = active.get(`${q.id} / ${trap.id}`) ?? [];
        const span = hit.length ? `${hit[0]}..${hit[hit.length - 1]}` : 'never';
        console.log(`  ${hit.length}/${months.length}  ${q.id} / ${trap.id}  (${span})`);
      }
    }
    console.log('\nMonths in which the gold answer differs from the month before:');
    for (const q of set.questions) {
      console.log(`  ${changes.get(q.id) ?? 0}/${months.length - 1}  ${q.id}`);
    }
    if (skipped.size) {
      console.log('\nNot askable:');
      for (const [id, when] of skipped) console.log(`  ${id}: ${when.join(', ')}`);
    }
    if (flags.has('json')) writeFileSync(need(flags, 'json'), JSON.stringify(all, null, 2));
    return skipped.size ? 1 : 0;
  }

  throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
}

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url));

// Assumptions behind the dry run's cost-per-session figure. They are guesses
// until a small live run replaces them with measured usage.
const DRY_RUN_ASSUMPTIONS: CostAssumptions = {
  steps: 6,
  outputTokensPerStep: 500,
  addedTokensPerStep: 600,
};

async function run(flags: Map<string, string>, dbPath: string): Promise<number> {
  const dryRun = flags.has('dry-run');
  const agentKind = dryRun ? 'oracle' : (flags.get('agent') ?? 'claude');
  const setups = (flags.get('setups') ?? SETUP_NAMES.join(',')).split(',') as SetupName[];
  for (const name of setups) {
    if (!SETUP_NAMES.includes(name)) throw new Error(`Unknown setup "${name}"`);
  }
  const model = flags.get('model') ?? DEFAULT_CLAUDE_MODEL;
  const effort = (flags.get('effort') ?? 'medium') as Effort;
  const seed = Number(flags.get('seed') ?? 1);
  const live = agentKind === 'claude';
  const budgetUsd = live ? Number(need(flags, 'budget')) : Number(flags.get('budget') ?? 1);
  if (live && !PRICES[model]) throw new Error(`No price recorded for "${model}" (src/pricing.ts).`);

  const taxonomy = await loadTaxonomy();
  // Debrief reviews run on the same model as the agent unless told otherwise,
  // so a run involves a single model.
  const reviewModel = flags.get('review-model') ?? model;
  const createSetup = createSetupFactory(taxonomy, {
    reviewModel,
    seed,
    maxReviewsPerMonth: flags.has('max-reviews') ? Number(need(flags, 'max-reviews')) : undefined,
    // Scripted runs never call the review engine either.
    ...(live
      ? {}
      : {
          review: async () => ({
            findings: [],
            kind: 'transcript' as const,
            model: 'none',
            rulesConsidered: 0,
          }),
        }),
  });
  if (live) {
    console.log(
      `This run calls the Claude API (${model}, effort ${effort}; Debrief reviews on ${reviewModel}) ` +
        `and stops once estimated spend reaches $${budgetUsd.toFixed(2)}.`
    );
  }
  const summary = await runBenchmark(
    {
      db: dbPath,
      from: need(flags, 'from'),
      to: need(flags, 'to'),
      setups,
      outDir: need(flags, 'out'),
      budgetUsd,
      questionsFile: questionFile(flags),
      catalogFile: flags.get('traps') ?? repoFile('traps/catalog.yaml'),
      timelineFile: flags.get('timeline') ?? repoFile('context/timeline.yaml'),
      contextMode: (flags.get('context-mode') ?? 'announce-once') as ContextMode,
      questionIds: flags.get('only')?.split(','),
      maxSteps: flags.has('max-steps') ? Number(need(flags, 'max-steps')) : undefined,
      concurrency: flags.has('concurrency') ? Number(need(flags, 'concurrency')) : undefined,
      seed,
      keepAsOfDatabases: flags.has('keep-asof'),
      recorded: {
        effort: live ? effort : null,
        reviewModel: setups.includes('debrief') ? reviewModel : null,
        taxonomyVersion: taxonomy.taxonomyVersion,
        dryRun,
      },
    },
    {
      createSetup,
      createAgent: (key) =>
        live
          ? createClaudeAdapter({ model, effort, apiKey: benchApiKey() })
          : createScriptedAdapter(agentKind as Script, key),
      log: (line) => console.log(line),
    }
  );
  console.log(
    `\n${summary.sessions} sessions over ${summary.months.length} months -> ${summary.outDir}` +
      (live ? `, estimated spend $${summary.spentUsd.toFixed(2)}` : ', nothing spent')
  );
  if (summary.stoppedForBudget) console.log('STOPPED EARLY: the budget was reached.');
  if (dryRun) {
    const a = DRY_RUN_ASSUMPTIONS;
    console.log(
      `\nOpening prompt size per session (estimated tokens), and a rough cost per session assuming ` +
        `${a.steps} model requests, ${a.outputTokensPerStep} output tokens and ${a.addedTokensPerStep} added tokens per request.`
    );
    console.log('These costs are arithmetic on assumptions, not measurements.');
    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
    console.log(
      `  ${'setup'.padEnd(10)} ${'prompt'.padStart(8)}  ${models.map((m) => m.padStart(18)).join(' ')}`
    );
    const sessionsPerSetup = summary.sessions / setups.length;
    const totals = models.map(() => 0);
    for (const [name, tokens] of Object.entries(summary.promptTokensPerSession)) {
      const costs = models.map((m) => estimateSessionCost(m, tokens, a));
      costs.forEach((c, i) => (totals[i] = (totals[i] ?? 0) + c * sessionsPerSetup));
      console.log(
        `  ${name.padEnd(10)} ${String(tokens).padStart(8)}  ${costs.map((c) => `$${c.toFixed(4)}`.padStart(18)).join(' ')}`
      );
    }
    console.log(
      `  ${'whole run'.padEnd(10)} ${''.padStart(8)}  ${totals.map((c) => `$${c.toFixed(2)}`.padStart(18)).join(' ')}`
    );
    console.log('  (agent sessions only; Debrief reviews are extra.)');
  }
  return summary.stoppedForBudget ? 2 : 0;
}

function score(flags: Map<string, string>): number {
  const dir = need(flags, 'run');
  const { sessions, gold } = readRun(dir);
  const find = (month: string, id: string) => gold[month]?.find((q) => q.id === id);
  const months = Object.keys(gold).sort();
  const before = (month: string): string | undefined => months[months.indexOf(month) - 1];
  const scored = sessions.flatMap((s) => {
    const now = find(s.asOf, s.questionId);
    if (!now) return [];
    const prior = before(s.asOf);
    return [scoreSession(s, now, prior ? find(prior, s.questionId) : undefined)];
  });
  const summary = summarizeBySetup(scored);
  const setups = Object.keys(summary.overall);
  const seed = Number(flags.get('seed') ?? 1);
  const comparisons = setups.includes('debrief')
    ? ['cache', 'none']
        .filter((b) => setups.includes(b))
        .map((b) => compareSetups(scored, 'debrief', b, { seed }))
    : [];
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ ...summary, comparisons }, null, 2));
  writeFileSync(join(dir, 'metrics.csv'), metricsCsv(summary));
  const pct = (v: number | null): string =>
    v === null ? '    n/a' : `${(100 * v).toFixed(1)}%`.padStart(7);
  console.log(`${'setup'.padEnd(10)} sessions accuracy   stale pitfall  no-ans  tokens/q`);
  for (const name of setups) {
    const m = summary.overall[name];
    if (!m) continue;
    console.log(
      `${name.padEnd(10)} ${String(m.sessions).padStart(8)}  ${pct(m.accuracy)} ${pct(m.staleAnswerRate)} ${pct(m.pitfallErrorRate)} ${pct(m.noAnswerRate)}  ${String(Math.round(m.tokensPerQuestion ?? 0)).padStart(8)}`
    );
  }
  for (const c of comparisons) {
    const [lo, hi] = c.accuracyInterval;
    const cut = c.pitfallRate.reductionPct;
    console.log(
      `\ndebrief vs ${c.baseline} (${c.pairs} paired question-months): accuracy ${c.accuracyDiffPoints >= 0 ? '+' : ''}${c.accuracyDiffPoints.toFixed(1)} points ` +
        `(95% interval ${lo.toFixed(1)} to ${hi.toFixed(1)}); pitfall errors ${cut === null ? 'n/a' : `${cut.toFixed(0)}% fewer`}`
    );
  }
  console.log(`\nWrote ${join(dir, 'metrics.json')} and metrics.csv`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
);
