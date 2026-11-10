// Builds a small bench database for tests: the real schema (from the Python
// builder and its fixtures) plus a few synthetic months. All rows are fixtures.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A database with segments and markets for 2099-01 through 2099-06. */
export function buildFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-test-'));
  const path = join(dir, 'bench.db');
  execFileSync(
    'python3',
    [
      join(root, 'data/build_database.py'),
      '--fixtures',
      join(root, 'data/tests/fixtures'),
      '--db',
      path,
    ],
    { stdio: 'pipe' }
  );
  const db = new DatabaseSync(path);
  for (const table of ['segments', 'markets']) {
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk = 0`)
      .all()
      .map((c) => c.name);
    const shifted = (month) =>
      columns
        .map((c) =>
          c === 'month' ? String(month) : c === 'passengers' ? `passengers + ${month * 10}` : c
        )
        .join(', ');
    for (let month = 2; month <= 6; month++) {
      db.exec(
        `INSERT INTO ${table} (${columns.join(', ')})
         SELECT ${shifted(month)} FROM ${table} WHERE year = 2099 AND month = 1`
      );
    }
  }
  // A marker only the newest month carries, to prove later rows leave no trace.
  db.exec("UPDATE segments SET carrier_name = 'FIXTURE-JUNE-ONLY-MARKER' WHERE month = 6");
  db.exec(
    `INSERT INTO source_files SELECT 'later_' || file, kind, scope, year, 6, rows, sha256, fetched_at
     FROM source_files WHERE month = 1`
  );
  db.close();
  return { dir, path };
}
