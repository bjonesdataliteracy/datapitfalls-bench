// Question templates with gold answers computed by SQL (PRD 2, B3).
// No model writes or checks a gold answer: every answer here comes from a
// query run against the as-of data.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { addMonths, monthIndex, monthLabel } from './months.js';
import { trapCovers, type TrapWindow } from './traps.js';

export type AnswerType = 'number' | 'percent' | 'entity' | 'list';
export const ANSWER_TYPES: readonly AnswerType[] = ['number', 'percent', 'entity', 'list'];
export const CATEGORIES = ['level', 'trend', 'ranking', 'share', 'comparison'] as const;

export interface Tolerance {
  /** Allowed difference as a fraction of the gold value (number answers). */
  relative?: number;
  /** Allowed difference in the answer's own units (percentage points for percent). */
  absolute?: number;
}

export interface Standard {
  id: string;
  /** The business rule, in the words the agent will be given. */
  text: string;
  /** First data month the rule applies to; absent means from the start. */
  introduced?: string;
}

export interface TrapAnswer {
  /** A trap id from traps/catalog.yaml. */
  id: string;
  /** The query an analyst who falls into the trap would run. */
  sql: string;
}

export interface QuestionTemplate {
  id: string;
  category: (typeof CATEGORIES)[number];
  /** May contain {latest_month}, {prior_year_month}, {previous_month}, {window_start}. */
  text: string;
  answer: { type: AnswerType; unit?: string; tolerance?: Tolerance };
  standards: string[];
  gold_sql: string;
  traps: TrapAnswer[];
}

export interface QuestionSet {
  standards: Standard[];
  questions: QuestionTemplate[];
}

/** A scalar for number, percent and entity answers; an ordered list for list answers. */
export type AnswerValue = number | string | string[];

export interface GoldAnswer {
  value: AnswerValue;
  /** Other spellings accepted for an entity (for example a name next to a code). */
  aliases: string[];
}

export interface QuestionInstance {
  id: string;
  category: string;
  asOf: string;
  text: string;
  answer: QuestionTemplate['answer'];
  /** Standards in force this month that the gold answer applies. */
  standards: Standard[];
  gold: GoldAnswer;
  /**
   * One entry per labeled trap. `differs` is true when the trap's query gives a
   * different answer from gold this month; `active` also requires the month to
   * fall inside the trap's window in the catalog.
   */
  traps: { id: string; value: AnswerValue | null; differs: boolean; active: boolean }[];
}

const DEFAULT_TOLERANCE: Record<AnswerType, Tolerance> = {
  number: { relative: 0.01 },
  percent: { absolute: 0.5 },
  entity: {},
  list: {},
};

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

/** Load and check a question file. Throws with the offending id on any problem. */
export function loadQuestionSet(path: string): QuestionSet {
  const raw = yaml.load(readFileSync(path, 'utf8')) as Partial<QuestionSet> | null;
  if (!raw || !Array.isArray(raw.questions) || !Array.isArray(raw.standards)) {
    fail(path, 'expected top-level "standards" and "questions" lists');
  }
  const standardIds = new Set<string>();
  for (const s of raw.standards) {
    if (!s.id || !s.text) fail(path, 'every standard needs an id and text');
    if (standardIds.has(s.id)) fail(s.id, 'duplicate standard id');
    if (s.introduced) monthIndex(s.introduced);
    standardIds.add(s.id);
  }
  const seen = new Set<string>();
  const questions = raw.questions.map((q): QuestionTemplate => {
    const where = `question ${q.id ?? '(no id)'}`;
    if (!q.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(q.id)) fail(where, 'id must be kebab-case');
    if (seen.has(q.id)) fail(where, 'duplicate id');
    seen.add(q.id);
    if (!CATEGORIES.includes(q.category)) fail(where, `unknown category "${q.category}"`);
    if (!q.text) fail(where, 'missing text');
    if (!q.answer || !ANSWER_TYPES.includes(q.answer.type)) fail(where, 'unknown answer type');
    if (!/^\s*(select|with)\b/i.test(q.gold_sql ?? '')) fail(where, 'gold_sql must be a SELECT');
    const standards = q.standards ?? [];
    for (const id of standards) if (!standardIds.has(id)) fail(where, `unknown standard "${id}"`);
    const traps = q.traps ?? [];
    for (const trap of traps) {
      if (!trap.id || !/^\s*(select|with)\b/i.test(trap.sql ?? '')) {
        fail(where, 'every trap needs an id and a SELECT');
      }
    }
    return { ...q, standards, traps };
  });
  return { standards: raw.standards, questions };
}

/** Values every query can use as named parameters. */
export function sqlParameters(asOf: string): Record<string, number> {
  const t = monthIndex(asOf);
  return {
    ':t': t, // newest visible month, as year * 12 + month - 1
    ':y': Math.floor(t / 12),
    ':m': (t % 12) + 1,
    ':py': Math.floor((t - 12) / 12), // same month a year earlier
    ':pm': ((t - 12) % 12) + 1,
    ':ly': Math.floor((t - 1) / 12), // the month before
    ':lm': ((t - 1) % 12) + 1,
  };
}

function renderText(template: string, asOf: string): string {
  const values: Record<string, string> = {
    latest_month: monthLabel(asOf),
    prior_year_month: monthLabel(addMonths(asOf, -12)),
    previous_month: monthLabel(addMonths(asOf, -1)),
    window_start: monthLabel(addMonths(asOf, -11)),
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown placeholder ${whole}`);
    return value;
  });
}

function runAnswer(
  db: DatabaseSync,
  sql: string,
  type: AnswerType,
  params: Record<string, number>
): GoldAnswer | null {
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  statement.setReturnArrays(true);
  const rows = statement.all(params) as unknown as unknown[][];
  if (type === 'list') {
    const items = rows.map((r) => r[0]).filter((v) => v !== null && v !== undefined);
    return items.length ? { value: items.map(String), aliases: [] } : null;
  }
  const first = rows[0];
  if (!first || first[0] === null || first[0] === undefined) return null;
  if (type === 'entity') {
    const aliases = first.slice(1).filter((v) => v !== null && v !== undefined);
    return { value: String(first[0]), aliases: aliases.map(String) };
  }
  const n = Number(first[0]);
  return Number.isFinite(n) ? { value: n, aliases: [] } : null;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Whether `given` counts as the same answer as `expected`. Used for scoring too. */
export function answersMatch(
  answer: QuestionTemplate['answer'],
  expected: AnswerValue,
  given: AnswerValue,
  aliases: string[] = []
): boolean {
  const tolerance = { ...DEFAULT_TOLERANCE[answer.type], ...answer.tolerance };
  if (answer.type === 'number' || answer.type === 'percent') {
    if (typeof expected !== 'number' || typeof given !== 'number') return false;
    const allowed = Math.max(
      tolerance.absolute ?? 0,
      (tolerance.relative ?? 0) * Math.abs(expected)
    );
    return Math.abs(given - expected) <= allowed + 1e-9;
  }
  if (answer.type === 'entity') {
    if (typeof given !== 'string' || typeof expected !== 'string') return false;
    return [expected, ...aliases].some((x) => norm(x) === norm(given));
  }
  if (!Array.isArray(expected) || !Array.isArray(given)) return false;
  return (
    expected.length === given.length && expected.every((x, i) => norm(x) === norm(given[i] ?? ''))
  );
}

/**
 * Ask every question as of one month. `db` must already be limited to the
 * data visible then (see openAsOfView). Questions whose gold query returns
 * nothing that month are left out and listed in `skipped`.
 *
 * `trapWindows` comes from the trap catalog (loadTrapWindows). A trap is
 * active only in the months the catalog says it is present, so a difference
 * with some other cause is not counted as that pitfall.
 */
export function instantiate(
  set: QuestionSet,
  db: DatabaseSync,
  asOf: string,
  trapWindows: Map<string, TrapWindow>
): { questions: QuestionInstance[]; skipped: string[] } {
  const params = sqlParameters(asOf);
  const t = monthIndex(asOf);
  const questions: QuestionInstance[] = [];
  const skipped: string[] = [];
  for (const q of set.questions) {
    const gold = runAnswer(db, q.gold_sql, q.answer.type, params);
    if (!gold) {
      skipped.push(q.id);
      continue;
    }
    const traps = q.traps.map((trap) => {
      const fallen = runAnswer(db, trap.sql, q.answer.type, params);
      const value = fallen ? fallen.value : null;
      const differs = value !== null && !answersMatch(q.answer, gold.value, value, gold.aliases);
      return {
        id: trap.id,
        value,
        differs,
        active: differs && trapCovers(trapWindows.get(trap.id), t),
      };
    });
    questions.push({
      id: q.id,
      category: q.category,
      asOf,
      text: renderText(q.text, asOf),
      answer: q.answer,
      standards: set.standards.filter(
        (s) => q.standards.includes(s.id) && (!s.introduced || monthIndex(s.introduced) <= t)
      ),
      gold,
      traps,
    });
  }
  return { questions, skipped };
}
