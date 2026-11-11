// Memory setups (PRD 2, B6). A setup decides what an agent is shown before a
// session and what is kept afterwards. Sessions within a month are
// independent: everything a setup learns in a month becomes visible from the
// next month on, when `nightly` runs.
import type { MemoryRecord, PitfallReport, Transcript } from '@datapitfalls/schemas';
import type { AgentResult } from './agent.js';
import { addUsage, NO_USAGE, type Usage } from './pricing.js';
import type { AnswerValue } from './questions.js';

export type SetupName = 'none' | 'log-all' | 'cache' | 'pitfall' | 'debrief';
export const SETUP_NAMES: readonly SetupName[] = ['none', 'log-all', 'cache', 'pitfall', 'debrief'];

export interface SessionInfo {
  sessionId: string;
  asOf: string;
  questionId: string;
  question: string;
  /** Persona and memos shown this month. */
  context: string;
}

export interface MemorySetup {
  name: SetupName;
  /** Text added to the system prompt (for example what memory is for). */
  instructions: string;
  /** Whether sessions get the remember tool. */
  canRemember: boolean;
  /** Memory text for a session. Must not change within a month. */
  beforeSession(info: SessionInfo): string;
  afterSession(info: SessionInfo, result: AgentResult): void;
  /** Runs once after each month. Returns what it spent, if anything. */
  nightly(asOf: string): Promise<{ usage: Usage; model?: string }>;
  /** Size of what is carried forward, for the memory-size metric. */
  size(): { records: number; lines: number };
  /** A serializable copy of the memory, written to the run folder each month. */
  snapshot(): unknown;
}

const lines = (text: string): number => (text ? text.split('\n').length : 0);

function describe(answer: AnswerValue | null): string {
  if (answer === null) return '(no answer)';
  return Array.isArray(answer) ? answer.join(', ') : String(answer);
}

/** 1. No memory: every session starts from nothing. */
export function noMemory(): MemorySetup {
  return {
    name: 'none',
    instructions: '',
    canRemember: false,
    beforeSession: () => '',
    afterSession: () => undefined,
    nightly: async () => ({ usage: NO_USAGE }),
    size: () => ({ records: 0, lines: 0 }),
    snapshot: () => null,
  };
}

/** 2. Log everything: every context, question, query and answer is kept and shown back. */
export function logAll(): MemorySetup {
  const visible: string[] = [];
  let pending: string[] = [];
  const seenContext = new Set<string>();
  return {
    name: 'log-all',
    instructions:
      'You are shown a complete log of earlier sessions. It may be long and parts of it may be out of date.',
    canRemember: false,
    beforeSession: () => visible.join('\n'),
    afterSession(info, result) {
      if (!seenContext.has(`${info.asOf}|${info.context}`)) {
        seenContext.add(`${info.asOf}|${info.context}`);
        pending.push(`[${info.asOf}] Context: ${info.context.replace(/\n+/g, ' ')}`);
      }
      const queries = result.transcript.events
        .filter((e) => e.type === 'query' && e.sql)
        .map((e) => (e.sql as string).replace(/\s+/g, ' '));
      pending.push(`[${info.asOf}] Q: ${info.question}`);
      for (const sql of queries) pending.push(`  SQL: ${sql}`);
      pending.push(`  A: ${describe(result.answer)}. ${result.explanation}`);
    },
    async nightly() {
      visible.push(...pending);
      pending = [];
      return { usage: NO_USAGE };
    },
    size: () => ({ records: visible.length, lines: visible.length }),
    snapshot: () => [...visible],
  };
}

/** 3. Cached answers: the last answer given to each question is shown back. */
export function cachedAnswers(): MemorySetup {
  const visible = new Map<string, { asOf: string; answer: string }>();
  const pending = new Map<string, { asOf: string; answer: string }>();
  return {
    name: 'cache',
    instructions:
      'You may be shown the answer given to this same question in an earlier month. Use it if it helps.',
    canRemember: false,
    beforeSession(info) {
      const hit = visible.get(info.questionId);
      return hit ? `Earlier answer to this question (as of ${hit.asOf}): ${hit.answer}` : '';
    },
    afterSession(info, result) {
      if (result.answer !== null) {
        pending.set(info.questionId, { asOf: info.asOf, answer: describe(result.answer) });
      }
    },
    async nightly() {
      for (const [id, entry] of pending) visible.set(id, entry);
      pending.clear();
      return { usage: NO_USAGE };
    },
    size: () => ({ records: visible.size, lines: visible.size }),
    snapshot: () => Object.fromEntries(visible),
  };
}

export const MEMORY_PURPOSE = `What memory is for: keep what a fresh query cannot tell you. That means quirks of this data that make an honest query give a wrong answer, mistakes in reasoning you made or nearly made, and decisions about how things are defined or counted. Do not save values a query returns, such as totals, rankings or last month's answer; they go out of date and can be re-read. The Avoiding Data Pitfalls taxonomy names the mistakes worth remembering, for example: partial-period-aggregation, uneven-aggregation-coverage, measurement-system-drift, data-reality-gap, unweighted-rate-average, join-key-mismatch-row-loss, small-sample-extremes, divide-by-tiny-denominator, simpsons-paradox, mismatched-units, multiple-comparisons.`;

export interface PitfallMemoryOptions {
  /** Checks a rule id and returns its current form, or undefined when unknown. */
  resolveRuleId: (id: string) => string | undefined;
  taxonomyVersion?: string;
  /** Most lines the injected index may have. */
  maxLines?: number;
}

/** Where a stored record came from: the working agent, or the Debrief review. */
export interface StoredRecord {
  origin: 'agent' | 'debrief';
  record: MemoryRecord;
}

const HALF_LIFE_DAYS: Record<MemoryRecord['kind'], number> = {
  decision: 365,
  quirk: 180,
  lesson: 365,
  hypothesis: 90,
};

function renderIndex(records: StoredRecord[], maxLines: number): string {
  const order: MemoryRecord['kind'][] = ['decision', 'quirk', 'lesson', 'hypothesis'];
  const out: string[] = [];
  for (const kind of order) {
    for (const { record } of records.filter((r) => r.record.kind === kind)) {
      out.push(`- [${kind}] ${record.statement} (${record.pitfall_ids.join(', ')})`);
    }
  }
  // Newest lines win when the index is over its budget.
  return out.slice(-maxLines).join('\n');
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** 4. Pitfall-steered memory: the agent is told what memory is for and saves its own notes. */
export function pitfallMemory(options: PitfallMemoryOptions): MemorySetup & {
  records(): StoredRecord[];
  add(stored: StoredRecord): boolean;
  rejectedNotes(): number;
} {
  const maxLines = options.maxLines ?? 200;
  const visible: StoredRecord[] = [];
  let pending: StoredRecord[] = [];
  let rejected = 0;
  let counter = 0;

  function add(stored: StoredRecord): boolean {
    const key = normalize(stored.record.statement);
    if ([...visible, ...pending].some((r) => normalize(r.record.statement) === key)) return false;
    pending.push(stored);
    return true;
  }

  return {
    name: 'pitfall',
    instructions: MEMORY_PURPOSE,
    canRemember: true,
    beforeSession: () => renderIndex(visible, maxLines),
    afterSession(info, result) {
      for (const note of result.notes) {
        // Every memory cites at least one real rule id; a note that cites none is dropped.
        const ids = [...new Set((note.pitfall_ids ?? []).map(options.resolveRuleId))].filter(
          (id): id is string => Boolean(id)
        );
        if (!ids.length || !note.statement?.trim()) {
          rejected += 1;
          continue;
        }
        counter += 1;
        add({
          origin: 'agent',
          record: {
            id: `${note.kind}-${String(counter).padStart(4, '0')}`,
            kind: note.kind,
            statement: note.statement.trim(),
            evidence: [
              {
                session_id: info.sessionId,
                ...(note.evidence_sql ? { query: note.evidence_sql } : {}),
              },
            ],
            pitfall_ids: ids,
            half_life_days: HALF_LIFE_DAYS[note.kind] ?? 180,
            created_at: `${info.asOf}-01`,
            status: 'proposed',
            confidence: 'medium',
            // TODO(schemas): MemoryRecord.source has no value for notes the working
            // agent writes itself; `origin` on the wrapper records the truth.
            source: 'debrief',
            ...(options.taxonomyVersion ? { taxonomyVersion: options.taxonomyVersion } : {}),
          },
        });
      }
    },
    async nightly() {
      visible.push(...pending);
      pending = [];
      return { usage: NO_USAGE };
    },
    size: () => ({ records: visible.length, lines: lines(renderIndex(visible, maxLines)) }),
    snapshot: () => visible.map((r) => ({ ...r })),
    records: () => visible,
    add,
    rejectedNotes: () => rejected,
  };
}

/** Reviews one session transcript against the taxonomy. The default uses the datapitfalls engine. */
export type TranscriptReviewer = (transcript: Transcript) => Promise<PitfallReport>;

export interface DebriefOptions extends PitfallMemoryOptions {
  review: TranscriptReviewer;
  /** Model the reviewer runs on, for cost accounting. */
  reviewModel: string;
  /** Most sessions reviewed per month. Sessions with query errors go first. */
  maxReviewsPerMonth?: number;
  /** Deterministic tie-break when choosing which sessions to review. */
  seed?: number;
  /** Most Debrief lessons kept for any one rule. */
  maxLessonsPerRule?: number;
}

function seededOrder<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return items
    .map((item) => ({ item, key: next() }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

/**
 * 5. Pitfall-steered memory plus Debrief: after each month, a sample of that
 * month's sessions is reviewed against the taxonomy and each solid finding
 * becomes a lesson. Re-verifying older memories is not part of this version.
 */
export function debriefMemory(options: DebriefOptions): MemorySetup & {
  records(): StoredRecord[];
  reviewsRun(): number;
} {
  const base = pitfallMemory(options);
  const month: { info: SessionInfo; result: AgentResult }[] = [];
  let reviews = 0;
  let lessons = 0;
  const perRule = new Map<string, number>();
  const maxPerRule = options.maxLessonsPerRule ?? 3;

  return {
    ...base,
    name: 'debrief',
    afterSession(info, result) {
      base.afterSession(info, result);
      month.push({ info, result });
    },
    async nightly(asOf) {
      const limit = options.maxReviewsPerMonth ?? 12;
      const shuffled = seededOrder(month, (options.seed ?? 1) + reviews);
      const chosen = [...shuffled]
        .sort((a, b) => b.result.sqlErrors - a.result.sqlErrors)
        .slice(0, limit);
      let usage = NO_USAGE;
      for (const { info, result } of chosen) {
        const report = await options.review(result.transcript);
        reviews += 1;
        usage = addUsage(usage, {
          inputTokens: report.usage?.inputTokens ?? 0,
          outputTokens: report.usage?.outputTokens ?? 0,
          cacheReadTokens: report.usage?.cacheReadInputTokens ?? 0,
          cacheWriteTokens: report.usage?.cacheCreationInputTokens ?? 0,
        });
        for (const finding of report.findings) {
          // Only findings the review saw in the session and is reasonably sure of.
          if (finding.nature !== 'active' || finding.confidence === 'low') continue;
          const id = options.resolveRuleId(finding.ruleId);
          if (!id) continue;
          // Keep the index small: a few lessons per rule say as much as dozens.
          if ((perRule.get(id) ?? 0) >= maxPerRule) continue;
          perRule.set(id, (perRule.get(id) ?? 0) + 1);
          lessons += 1;
          base.add({
            origin: 'debrief',
            record: {
              id: `lesson-debrief-${String(lessons).padStart(4, '0')}`,
              kind: 'lesson',
              statement: `${finding.explanation} ${finding.remediation}`.trim(),
              evidence: [{ session_id: info.sessionId, events: finding.eventRefs ?? [] }],
              pitfall_ids: [id],
              half_life_days: HALF_LIFE_DAYS.lesson,
              created_at: `${asOf}-01`,
              status: 'proposed',
              confidence: finding.confidence,
              source: 'debrief',
              ...(report.taxonomyVersion ? { taxonomyVersion: report.taxonomyVersion } : {}),
            },
          });
        }
      }
      month.length = 0;
      await base.nightly(asOf);
      return { usage, model: options.reviewModel };
    },
    reviewsRun: () => reviews,
  };
}
