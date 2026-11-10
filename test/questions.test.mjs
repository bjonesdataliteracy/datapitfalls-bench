import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  answersMatch,
  loadTrapWindows,
  instantiate,
  loadQuestionSet,
  openAsOfView,
  sqlParameters,
} from '../dist/index.js';
import { buildFixtureDb } from './helpers.mjs';

const { dir, path } = buildFixtureDb();
test.after(() => rmSync(dir, { recursive: true, force: true }));
const file = new URL('../questions/questions.yaml', import.meta.url);
const set = loadQuestionSet(file.pathname);
const windows = loadTrapWindows(new URL('../traps/catalog.yaml', import.meta.url).pathname);
const catalog = yaml.load(readFileSync(new URL('../traps/catalog.yaml', import.meta.url), 'utf8'));

test('the question file loads, with unique ids', () => {
  assert.ok(set.questions.length >= 30);
  assert.equal(new Set(set.questions.map((q) => q.id)).size, set.questions.length);
});

test('about a third of the questions are trap-adjacent', () => {
  const share = set.questions.filter((q) => q.traps.length).length / set.questions.length;
  assert.ok(share >= 0.25 && share <= 0.45, `trap-adjacent share is ${share.toFixed(2)}`);
});

test('every trap a question names is in the trap catalog', () => {
  const ids = new Set(catalog.map((t) => t.id));
  for (const q of set.questions) {
    for (const trap of q.traps) assert.ok(ids.has(trap.id), `${q.id}: unknown trap "${trap.id}"`);
  }
});

test('every standard is used, and questions only cite standards that exist', () => {
  const used = new Set(set.questions.flatMap((q) => q.standards));
  for (const s of set.standards) assert.ok(used.has(s.id), `standard "${s.id}" is never used`);
});

test('every query is a read-only SELECT that compiles against the real schema', () => {
  const db = openAsOfView(path, '2099-06');
  const params = sqlParameters('2099-06');
  for (const q of set.questions) {
    for (const [label, sql] of [['gold', q.gold_sql], ...q.traps.map((t) => [t.id, t.sql])]) {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i);
      assert.doesNotMatch(sql, /\bmain\./i, `${q.id} ${label}: must not bypass the as-of view`);
      try {
        const statement = db.prepare(sql);
        statement.setAllowUnknownNamedParameters(true);
        statement.all(params);
      } catch (error) {
        assert.fail(`${q.id} ${label}: ${error.message}`);
      }
    }
  }
  db.close();
});

test('question text uses only known placeholders', () => {
  const db = openAsOfView(path, '2099-06');
  assert.doesNotThrow(() => instantiate(set, db, '2099-06', windows));
  db.close();
});

test('answers match within tolerance, by alias, and by ordered list', () => {
  const number = { type: 'number' };
  assert.ok(answersMatch(number, 1000, 1009));
  assert.ok(!answersMatch(number, 1000, 1011));
  assert.ok(!answersMatch({ type: 'number', tolerance: { absolute: 0, relative: 0 } }, 235, 236));
  const percent = { type: 'percent', tolerance: { absolute: 0.5 } };
  assert.ok(answersMatch(percent, -1.55, -1.2));
  assert.ok(!answersMatch(percent, -1.55, -9.19));
  const entity = { type: 'entity' };
  assert.ok(answersMatch(entity, 'WN', ' wn '));
  assert.ok(answersMatch(entity, 'WN', 'Southwest Airlines Co.', ['Southwest Airlines Co.']));
  assert.ok(!answersMatch(entity, 'WN', 'DL'));
  const list = { type: 'list' };
  assert.ok(answersMatch(list, ['UA', 'AA', 'DL'], ['ua', 'aa', 'dl']));
  assert.ok(!answersMatch(list, ['UA', 'AA', 'DL'], ['AA', 'UA', 'DL']));
  assert.ok(!answersMatch(number, 1000, '1000'));
});

test('instantiate computes gold, flags active traps and applies standards by date', () => {
  const custom = join(dir, 'q.yaml');
  writeFileSync(
    custom,
    yaml.dump({
      standards: [
        { id: 'always', text: 'Always in force.' },
        { id: 'later', text: 'Starts in April.', introduced: '2099-04' },
      ],
      questions: [
        {
          id: 'pax',
          category: 'level',
          text: 'Passengers in {latest_month} against {previous_month}?',
          answer: { type: 'number' },
          standards: ['always', 'later'],
          gold_sql:
            "SELECT SUM(passengers) FROM segments WHERE year = :y AND month = :m AND scope = 'domestic'",
          traps: [
            {
              id: 'same',
              sql: "SELECT SUM(passengers) FROM segments WHERE year = :y AND month = :m AND scope = 'domestic'",
            },
            {
              id: 'different',
              sql: 'SELECT SUM(passengers) FROM segments WHERE year = :y AND month = :m',
            },
          ],
        },
        {
          id: 'empty',
          category: 'level',
          text: 'A carrier that is not there?',
          answer: { type: 'number' },
          gold_sql: "SELECT SUM(passengers) FROM segments WHERE carrier_code = 'NOPE'",
        },
      ],
    })
  );
  const small = loadQuestionSet(custom);
  const db = openAsOfView(path, '2099-03');
  // 'different' is in the catalog from April on; 'same' for the whole window.
  const customWindows = new Map([
    ['same', { start: 0, end: null }],
    ['different', { start: 2099 * 12 + 3, end: null }],
  ]);
  const march = instantiate(small, db, '2099-03', customWindows);
  db.close();
  assert.deepEqual(march.skipped, ['empty']);
  const [q] = march.questions;
  assert.equal(q.text, 'Passengers in March 2099 against February 2099?');
  assert.equal(q.gold.value, 180); // fixture row of 150, plus 10 per month
  assert.deepEqual(
    q.traps.map((t) => [t.id, t.differs, t.active]),
    [
      ['same', false, false],
      ['different', true, false], // a different answer, but before the trap's window
    ]
  );
  assert.deepEqual(
    q.standards.map((s) => s.id),
    ['always']
  );
  const db2 = openAsOfView(path, '2099-05');
  const may = instantiate(small, db2, '2099-05', customWindows);
  db2.close();
  assert.deepEqual(
    may.questions[0].traps.map((t) => [t.id, t.active]),
    [
      ['same', false],
      ['different', true],
    ]
  );
  assert.deepEqual(
    may.questions[0].standards.map((s) => s.id),
    ['always', 'later']
  );
});

test('a broken question file is refused with the question named', () => {
  const bad = join(dir, 'bad.yaml');
  const write = (q) => writeFileSync(bad, yaml.dump({ standards: [], questions: [q] }));
  const base = {
    id: 'ok',
    category: 'level',
    text: 't',
    answer: { type: 'number' },
    gold_sql: 'SELECT 1',
  };
  write({ ...base, gold_sql: 'DELETE FROM segments' });
  assert.throws(() => loadQuestionSet(bad), /question ok: gold_sql must be a SELECT/);
  write({ ...base, standards: ['missing'] });
  assert.throws(() => loadQuestionSet(bad), /unknown standard "missing"/);
  write({ ...base, answer: { type: 'essay' } });
  assert.throws(() => loadQuestionSet(bad), /unknown answer type/);
  write({ ...base, id: 'Not Kebab' });
  assert.throws(() => loadQuestionSet(bad), /kebab-case/);
});
