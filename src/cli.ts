#!/usr/bin/env node
// datapitfalls-bench command line. Run with no arguments for usage.
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { monthRange } from './months.js';
import { instantiate, loadQuestionSet } from './questions.js';
import { materializeAsOf, newestVisibleMonth, openAsOfView } from './replay.js';
import { loadTrapWindows } from './traps.js';

const USAGE = `datapitfalls-bench

  asof       --db <bench.db> --as-of YYYY-MM --out <file> [--no-vacuum]
             Write a copy of the database holding only data published by that month.
  questions  --db <bench.db> --as-of YYYY-MM [--json <file>]
             Print every question for that month with its gold answer.
  check      --db <bench.db> --from YYYY-MM --to YYYY-MM [--json <file>]
             Ask every question in every month and report gaps and active traps.

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

function main(argv: string[]): number {
  const { command, flags } = parseArgs(argv);
  if (!command || command === 'help' || flags.has('help')) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const dbPath = need(flags, 'db');
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);

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

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
