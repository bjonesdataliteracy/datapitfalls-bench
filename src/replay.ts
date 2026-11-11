// As-of replay (PRD 2, B1): show only the months of data that had been
// published by a given point in time. The source database is never changed.
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addMonths, monthIndex } from './months.js';

/** Tables that hold one row per month of traffic. */
const FACT_TABLES = ['segments', 'markets'] as const;
const MONTH_EXPR = 'year * 12 + month - 1';

/** BTS publishes a T-100 month about ten weeks after it ends. */
export const DEFAULT_RELEASE_LAG_MONTHS = 3;

/** The newest data month an analyst working in `simulatedMonth` could see. */
export function newestVisibleMonth(
  simulatedMonth: string,
  lagMonths = DEFAULT_RELEASE_LAG_MONTHS
): string {
  if (!Number.isInteger(lagMonths) || lagMonths < 0) {
    throw new Error(`Release lag must be a whole number of months, got ${lagMonths}`);
  }
  return addMonths(simulatedMonth, -lagMonths);
}

/** First and last month of traffic in a bench database. */
export function dataSpan(db: DatabaseSync): { from: number; to: number } {
  const row = db
    .prepare(`SELECT MIN(${MONTH_EXPR}) AS lo, MAX(${MONTH_EXPR}) AS hi FROM main.segments`)
    .get() as { lo: number | null; hi: number | null };
  if (row.lo === null || row.hi === null) throw new Error('The database has no segment rows.');
  return { from: row.lo, to: row.hi };
}

function checkAsOf(db: DatabaseSync, asOf: string): number {
  const t = monthIndex(asOf);
  const span = dataSpan(db);
  if (t < span.from || t > span.to) {
    throw new Error(`As-of month ${asOf} is outside the data in this database.`);
  }
  return t;
}

/**
 * Open the source database read-only with the fact tables hidden behind
 * views that stop at `asOf`. Fast, and nothing is copied, but the full
 * tables are still reachable as main.segments, so this is for trusted code
 * (computing gold answers), never for an agent.
 */
export function openAsOfView(sourcePath: string, asOf: string): DatabaseSync {
  if (!existsSync(sourcePath)) throw new Error(`No database at ${sourcePath}`);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  const t = checkAsOf(db, asOf);
  for (const table of FACT_TABLES) {
    db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table} WHERE ${MONTH_EXPR} <= ${t}`);
  }
  db.exec(
    `CREATE TEMP VIEW source_files AS SELECT * FROM main.source_files
     WHERE year IS NULL OR ${MONTH_EXPR} <= ${t}`
  );
  return db;
}

export interface MaterializeOptions {
  /** Rewrite the file so removed rows leave no trace in it. Slower. Default true. */
  vacuum?: boolean;
}

/**
 * Write a separate database file that contains only the months published by
 * `asOf`. Later months are removed from the copy, so an agent given this
 * file cannot reach them by any query. Returns the rows kept per table.
 */
export function materializeAsOf(
  sourcePath: string,
  asOf: string,
  outPath: string,
  options: MaterializeOptions = {}
): Record<string, number> {
  if (!existsSync(sourcePath)) throw new Error(`No database at ${sourcePath}`);
  if (outPath === sourcePath) throw new Error('The as-of copy cannot overwrite its source.');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let t: number;
  try {
    t = checkAsOf(source, asOf);
  } finally {
    source.close();
  }
  rmSync(outPath, { force: true });
  copyFileSync(sourcePath, outPath);
  const db = new DatabaseSync(outPath);
  const kept: Record<string, number> = {};
  try {
    for (const table of FACT_TABLES) {
      db.exec(`DELETE FROM ${table} WHERE ${MONTH_EXPR} > ${t}`);
      kept[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    db.exec(`DELETE FROM source_files WHERE year IS NOT NULL AND ${MONTH_EXPR} > ${t}`);
    db.exec('CREATE TABLE bench_as_of (as_of TEXT NOT NULL)');
    db.prepare('INSERT INTO bench_as_of VALUES (?)').run(asOf);
    if (options.vacuum ?? true) db.exec('VACUUM');
  } finally {
    db.close();
  }
  return kept;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when more rows existed than were returned. */
  truncated: boolean;
}

/**
 * Run one read-only query for an agent. Only a single SELECT (or WITH ...
 * SELECT) is accepted; the connection should also be opened read-only.
 */
export function runReadOnlyQuery(db: DatabaseSync, sql: string, maxRows = 200): QueryResult {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text)) {
    throw new Error('Only SELECT queries are allowed.');
  }
  if (text.includes(';')) throw new Error('Only one statement is allowed per query.');
  const statement = db.prepare(text);
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  const columns = statement.columns().map((c) => c.name);
  return { columns, rows, truncated };
}
