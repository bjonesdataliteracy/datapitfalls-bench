// Scorer (PRD 2, B7): turns recorded answers into the benchmark's metrics.
// Written here, not taken from the core engine, because core's eval scoring
// measures findings, not answers.
import { addUsage, NO_USAGE, type Usage } from './pricing.js';
import { answersMatch, type AnswerValue, type QuestionInstance } from './questions.js';

export type Outcome = 'correct' | 'pitfall' | 'stale' | 'wrong' | 'no_answer';

export interface SessionRecord {
  setup: string;
  asOf: string;
  questionId: string;
  answer: AnswerValue | null;
  usage: Usage;
  /** Tokens of memory text shown to the agent, estimated at four characters per token. */
  memoryTokens: number;
  steps: number;
  error?: string;
}

export interface ScoredSession extends SessionRecord {
  outcome: Outcome;
  /** The trap fallen into, when outcome is 'pitfall'. */
  trapId?: string;
  /** Whether any labeled trap was active for this question and month. */
  trapActive: boolean;
  /** Whether gold differs from the month before, so a stale answer is possible. */
  goldChanged: boolean;
}

/**
 * Score one answer. Order matters: an answer that matches gold is correct even
 * if it also matches something else. A wrong answer is a pitfall error when it
 * matches an active trap's answer, stale when it matches last month's gold.
 */
export function scoreSession(
  session: SessionRecord,
  now: QuestionInstance,
  previous: QuestionInstance | undefined
): ScoredSession {
  const activeTraps = now.traps.filter((t) => t.active && t.value !== null);
  const goldChanged =
    previous !== undefined &&
    !answersMatch(now.answer, now.gold.value, previous.gold.value, now.gold.aliases);
  const base = { ...session, trapActive: activeTraps.length > 0, goldChanged };
  if (session.answer === null) return { ...base, outcome: 'no_answer' };
  if (answersMatch(now.answer, now.gold.value, session.answer, now.gold.aliases)) {
    return { ...base, outcome: 'correct' };
  }
  for (const trap of activeTraps) {
    if (answersMatch(now.answer, trap.value as AnswerValue, session.answer)) {
      return { ...base, outcome: 'pitfall', trapId: trap.id };
    }
  }
  if (
    goldChanged &&
    previous &&
    answersMatch(now.answer, previous.gold.value, session.answer, previous.gold.aliases)
  ) {
    return { ...base, outcome: 'stale' };
  }
  return { ...base, outcome: 'wrong' };
}

export interface Metrics {
  sessions: number;
  /** Share of answers within tolerance of gold. */
  accuracy: number | null;
  /** Among questions whose gold changed from the month before: share answered with last month's gold. */
  staleAnswerRate: number | null;
  /** Among question-months with an active trap: share that fell into it. */
  pitfallErrorRate: number | null;
  noAnswerRate: number | null;
  /** Input plus output tokens per question, cache reads and writes included. */
  tokensPerQuestion: number | null;
  memoryTokensPerQuestion: number | null;
  usage: Usage;
  counts: Record<Outcome, number>;
  trapActiveSessions: number;
  goldChangedSessions: number;
}

const ratio = (a: number, b: number): number | null => (b ? a / b : null);

export function summarize(scored: ScoredSession[]): Metrics {
  const counts: Record<Outcome, number> = {
    correct: 0,
    pitfall: 0,
    stale: 0,
    wrong: 0,
    no_answer: 0,
  };
  let usage = NO_USAGE;
  let memoryTokens = 0;
  for (const s of scored) {
    counts[s.outcome] += 1;
    usage = addUsage(usage, s.usage);
    memoryTokens += s.memoryTokens;
  }
  const trapActive = scored.filter((s) => s.trapActive);
  const changed = scored.filter((s) => s.goldChanged);
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    sessions: scored.length,
    accuracy: ratio(counts.correct, scored.length),
    staleAnswerRate: ratio(changed.filter((s) => s.outcome === 'stale').length, changed.length),
    pitfallErrorRate: ratio(
      trapActive.filter((s) => s.outcome === 'pitfall').length,
      trapActive.length
    ),
    noAnswerRate: ratio(counts.no_answer, scored.length),
    tokensPerQuestion: ratio(tokens, scored.length),
    memoryTokensPerQuestion: ratio(memoryTokens, scored.length),
    usage,
    counts,
    trapActiveSessions: trapActive.length,
    goldChangedSessions: changed.length,
  };
}

/** Metrics for each setup overall and for each setup and month. */
export function summarizeBySetup(scored: ScoredSession[]): {
  overall: Record<string, Metrics>;
  byMonth: Record<string, Record<string, Metrics>>;
} {
  const overall: Record<string, Metrics> = {};
  const byMonth: Record<string, Record<string, Metrics>> = {};
  for (const setup of [...new Set(scored.map((s) => s.setup))]) {
    const mine = scored.filter((s) => s.setup === setup);
    overall[setup] = summarize(mine);
    byMonth[setup] = {};
    for (const month of [...new Set(mine.map((s) => s.asOf))].sort()) {
      (byMonth[setup] as Record<string, Metrics>)[month] = summarize(
        mine.filter((s) => s.asOf === month)
      );
    }
  }
  return { overall, byMonth };
}

export interface Comparison {
  setup: string;
  baseline: string;
  /** Question-months both setups answered. */
  pairs: number;
  /** Accuracy difference in percentage points, setup minus baseline. */
  accuracyDiffPoints: number;
  /** 95% bootstrap interval for that difference. */
  accuracyInterval: [number, number];
  /** Pitfall error rates over the trap-active pairs, and the relative reduction. */
  pitfallRate: { setup: number | null; baseline: number | null; reductionPct: number | null };
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Compare two setups on the question-months both answered (paired), with a
 * bootstrap interval for the accuracy difference. This is the PRD's proposed
 * decision rule; it treats question-months as independent, which overstates
 * certainty when the same question is asked every month.
 */
export function compareSetups(
  scored: ScoredSession[],
  setup: string,
  baseline: string,
  options: { seed?: number; resamples?: number } = {}
): Comparison {
  const key = (s: ScoredSession): string => `${s.asOf}|${s.questionId}`;
  const base = new Map(scored.filter((s) => s.setup === baseline).map((s) => [key(s), s]));
  const pairs = scored
    .filter((s) => s.setup === setup && base.has(key(s)))
    .map((s) => ({ a: s, b: base.get(key(s)) as ScoredSession }));
  const diff = (sample: typeof pairs): number =>
    sample.length
      ? (100 *
          sample.reduce(
            (sum, p) => sum + Number(p.a.outcome === 'correct') - Number(p.b.outcome === 'correct'),
            0
          )) /
        sample.length
      : 0;
  const random = rng(options.seed ?? 1);
  const resamples = options.resamples ?? 2000;
  const draws: number[] = [];
  for (let i = 0; i < resamples && pairs.length; i++) {
    const sample = pairs.map(
      () => pairs[Math.floor(random() * pairs.length)] as (typeof pairs)[number]
    );
    draws.push(diff(sample));
  }
  draws.sort((x, y) => x - y);
  const at = (q: number): number =>
    draws[Math.min(draws.length - 1, Math.floor(q * draws.length))] ?? 0;
  const trap = pairs.filter((p) => p.a.trapActive);
  const rate = (pick: 'a' | 'b'): number | null =>
    ratio(trap.filter((p) => p[pick].outcome === 'pitfall').length, trap.length);
  const ra = rate('a');
  const rb = rate('b');
  return {
    setup,
    baseline,
    pairs: pairs.length,
    accuracyDiffPoints: diff(pairs),
    accuracyInterval: [at(0.025), at(0.975)],
    pitfallRate: {
      setup: ra,
      baseline: rb,
      reductionPct: ra !== null && rb ? 100 * (1 - ra / rb) : null,
    },
  };
}

const CSV_COLUMNS = [
  'setup',
  'month',
  'sessions',
  'accuracy',
  'stale_answer_rate',
  'pitfall_error_rate',
  'no_answer_rate',
  'tokens_per_question',
  'memory_tokens_per_question',
] as const;

/** Per-setup, per-month metrics as CSV text, with an "all" row for each setup. */
export function metricsCsv(summary: ReturnType<typeof summarizeBySetup>): string {
  const cell = (v: number | null): string =>
    v === null ? '' : String(Math.round(v * 10000) / 10000);
  const row = (setup: string, month: string, m: Metrics): string =>
    [
      setup,
      month,
      m.sessions,
      cell(m.accuracy),
      cell(m.staleAnswerRate),
      cell(m.pitfallErrorRate),
      cell(m.noAnswerRate),
      cell(m.tokensPerQuestion),
      cell(m.memoryTokensPerQuestion),
    ].join(',');
  const out = [CSV_COLUMNS.join(',')];
  for (const [setup, months] of Object.entries(summary.byMonth)) {
    for (const [month, m] of Object.entries(months)) out.push(row(setup, month, m));
    out.push(row(setup, 'all', summary.overall[setup] as Metrics));
  }
  return `${out.join('\n')}\n`;
}
