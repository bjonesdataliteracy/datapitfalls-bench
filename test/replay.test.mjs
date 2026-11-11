import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  addMonths,
  materializeAsOf,
  monthFromIndex,
  monthIndex,
  monthLabel,
  monthRange,
  newestVisibleMonth,
  openAsOfView,
  runReadOnlyQuery,
} from '../dist/index.js';
import { buildFixtureDb } from './helpers.mjs';

const { dir, path } = buildFixtureDb();
test.after(() => rmSync(dir, { recursive: true, force: true }));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const count = (db, sql) => db.prepare(sql).get().n;

test('month helpers round-trip and shift across years', () => {
  assert.equal(monthFromIndex(monthIndex('2026-07')), '2026-07');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-11', 3), '2026-02');
  assert.equal(monthLabel('2026-07'), 'July 2026');
  assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.throws(() => monthIndex('2026-13'), /YYYY-MM/);
  assert.throws(() => monthIndex('July 2026'), /YYYY-MM/);
});

test('the newest visible month trails the simulated month by the release lag', () => {
  assert.equal(newestVisibleMonth('2026-10'), '2026-07');
  assert.equal(newestVisibleMonth('2026-01', 2), '2025-11');
  assert.throws(() => newestVisibleMonth('2026-01', -1), /lag/);
});

test('the as-of view hides later months and leaves the source untouched', () => {
  const before = sha(path);
  const db = openAsOfView(path, '2099-03');
  assert.equal(count(db, 'SELECT MAX(month) AS n FROM segments'), 3);
  assert.equal(count(db, 'SELECT MAX(month) AS n FROM markets'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM segments'), 6);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE file LIKE 'later_%'"), 0);
  // Dimension tables are not month-bound and stay whole.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM airports'), 3);
  assert.throws(() => db.exec('DELETE FROM main.segments'), /readonly/);
  db.close();
  assert.equal(sha(path), before);
});

test('a materialized copy contains no later month by any route', () => {
  const before = sha(path);
  const out = join(dir, 'asof.db');
  const kept = materializeAsOf(path, '2099-03', out);
  assert.deepEqual(kept, { segments: 6, markets: 6 });
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(count(db, 'SELECT MAX(month) AS n FROM main.segments'), 3);
  assert.equal(count(db, 'SELECT MAX(month) AS n FROM main.markets'), 3);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE file LIKE 'later_%'"), 0);
  assert.equal(db.prepare('SELECT as_of FROM bench_as_of').get().as_of, '2099-03');
  db.close();
  // After VACUUM the removed rows are gone from the file's bytes too, not
  // just from query results. The source still has them and is unchanged.
  assert.ok(readFileSync(path).includes('FIXTURE-JUNE-ONLY-MARKER'));
  assert.ok(!readFileSync(out).includes('FIXTURE-JUNE-ONLY-MARKER'));
  assert.equal(sha(path), before);
});

test('the view and the materialized copy agree', () => {
  const out = join(dir, 'agree.db');
  materializeAsOf(path, '2099-04', out, { vacuum: false });
  const view = openAsOfView(path, '2099-04');
  const copy = new DatabaseSync(out, { readOnly: true });
  const sql =
    'SELECT year, month, scope, SUM(passengers) AS p FROM segments GROUP BY 1, 2, 3 ORDER BY 1, 2, 3';
  assert.deepEqual(view.prepare(sql).all(), copy.prepare(sql).all());
  view.close();
  copy.close();
});

test('as-of months outside the data, and overwriting the source, are refused', () => {
  assert.throws(() => openAsOfView(path, '2098-12'), /outside the data/);
  assert.throws(() => materializeAsOf(path, '2099-07', join(dir, 'x.db')), /outside the data/);
  assert.throws(() => materializeAsOf(path, '2099-03', path), /overwrite/);
  assert.throws(() => openAsOfView(join(dir, 'missing.db'), '2099-03'), /No database/);
});

test('the query tool accepts one SELECT and nothing else', () => {
  const db = openAsOfView(path, '2099-06');
  const result = runReadOnlyQuery(db, 'SELECT year, month FROM segments ORDER BY month;', 5);
  assert.deepEqual(result.columns, ['year', 'month']);
  assert.equal(result.rows.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(runReadOnlyQuery(db, 'WITH x AS (SELECT 1 AS a) SELECT a FROM x').rows[0].a, 1);
  assert.throws(() => runReadOnlyQuery(db, 'DELETE FROM segments'), /Only SELECT/);
  assert.throws(() => runReadOnlyQuery(db, 'PRAGMA table_info(segments)'), /Only SELECT/);
  assert.throws(() => runReadOnlyQuery(db, 'SELECT 1; SELECT 2'), /one statement/);
  db.close();
});
