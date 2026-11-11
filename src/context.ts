// Business-context timeline (PRD 2, B4): what the analyst is told each month.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { monthIndex } from './months.js';
import type { Standard } from './questions.js';

export interface Persona {
  from: string;
  name: string;
  text: string;
}

export interface Memo {
  month: string;
  /** Text given to the agent. Filled from the standard when `standard` is set. */
  text: string;
  standard?: string;
}

export interface Timeline {
  personas: Persona[];
  memos: Memo[];
}

/** 'announce-once': a memo appears only in its own month. 'always': every memo issued so far. */
export type ContextMode = 'announce-once' | 'always';

interface RawMemo {
  month?: string;
  text?: string;
  standard?: string;
}

/** Load the timeline and resolve memos that announce a standard. */
export function loadTimeline(path: string, standards: Standard[]): Timeline {
  const raw = yaml.load(readFileSync(path, 'utf8')) as {
    personas?: Persona[];
    memos?: RawMemo[];
  } | null;
  if (!raw || !Array.isArray(raw.personas) || !Array.isArray(raw.memos)) {
    throw new Error(`${path}: expected top-level "personas" and "memos" lists`);
  }
  if (!raw.personas.length) throw new Error(`${path}: at least one persona is required`);
  for (const p of raw.personas) {
    if (!p.name || !p.text) throw new Error(`${path}: every persona needs a name and text`);
    monthIndex(p.from);
  }
  const byId = new Map(standards.map((s) => [s.id, s]));
  const memos = raw.memos.map((m): Memo => {
    if (!m.month) throw new Error(`${path}: every memo needs a month`);
    monthIndex(m.month);
    if (m.standard) {
      const standard = byId.get(m.standard);
      if (!standard) throw new Error(`${path}: memo names unknown standard "${m.standard}"`);
      if (standard.introduced && standard.introduced !== m.month) {
        throw new Error(
          `${path}: standard "${m.standard}" is introduced ${standard.introduced} but announced ${m.month}`
        );
      }
      return { month: m.month, standard: m.standard, text: standard.text };
    }
    if (!m.text) throw new Error(`${path}: a memo needs "standard" or "text"`);
    return { month: m.month, text: m.text };
  });
  return {
    personas: [...raw.personas].sort((a, b) => monthIndex(a.from) - monthIndex(b.from)),
    memos,
  };
}

export interface MonthContext {
  persona: Persona;
  /** Memos shown to the agent this month. */
  memos: Memo[];
}

/** The context for one data month. Memos dated before `firstMonth` are issued in `firstMonth`. */
export function contextFor(
  timeline: Timeline,
  month: string,
  firstMonth: string,
  mode: ContextMode
): MonthContext {
  const t = monthIndex(month);
  const first = monthIndex(firstMonth);
  const persona = [...timeline.personas].reverse().find((p) => monthIndex(p.from) <= t);
  const issued = (m: Memo): number => Math.max(monthIndex(m.month), first);
  const memos = timeline.memos.filter((m) =>
    mode === 'always' ? issued(m) <= t : issued(m) === t
  );
  return { persona: persona ?? (timeline.personas[0] as Persona), memos };
}

/** The context as the text block an agent reads. */
export function renderContext(context: MonthContext): string {
  const lines = [`Who you are working for: ${context.persona.text}`];
  if (context.memos.length) {
    lines.push('', 'Reporting standards announced this month:');
    for (const memo of context.memos) lines.push(`- ${memo.text}`);
  }
  return lines.join('\n');
}
