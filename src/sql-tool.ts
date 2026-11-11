// The agent's only route to the data: one read-only SELECT at a time against
// the as-of database, with a row cap and a time limit.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { QueryResult } from './replay.js';

export interface SqlToolOptions {
  maxRows?: number;
  timeoutMs?: number;
  /** Longest result text handed back to the agent. */
  maxChars?: number;
}

export type SqlTool = (sql: string) => Promise<{ ok: boolean; text: string }>;

function toCsv(result: QueryResult): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [result.columns.join(',')];
  for (const row of result.rows) lines.push(result.columns.map((c) => cell(row[c])).join(','));
  return lines.join('\n');
}

function runInChild(
  dbPath: string,
  sql: string,
  maxRows: number,
  timeoutMs: number
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./sql-worker.js', import.meta.url)), [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new Error(`Query stopped after ${Math.round(timeoutMs / 1000)} seconds. Make it cheaper.`)
        )
      );
    }, timeoutMs);
    child.once('message', (message: { ok: boolean; result?: QueryResult; error?: string }) => {
      finish(() =>
        message.ok && message.result
          ? resolve(message.result)
          : reject(new Error(message.error ?? 'Query failed'))
      );
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', () =>
      finish(() => reject(new Error('Query process ended without a result')))
    );
    child.send({ dbPath, sql, maxRows });
  });
}

/** A query function bound to one as-of database file. Errors come back as text, not exceptions. */
export function createSqlTool(dbPath: string, options: SqlToolOptions = {}): SqlTool {
  const maxRows = options.maxRows ?? 50;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxChars = options.maxChars ?? 6000;
  return async (sql) => {
    try {
      const result = await runInChild(dbPath, sql, maxRows, timeoutMs);
      let text = result.rows.length ? toCsv(result) : '(no rows)';
      if (result.truncated) text += `\n(only the first ${maxRows} rows are shown)`;
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n(result cut off: too long)`;
      return { ok: true, text };
    } catch (error) {
      return {
        ok: false,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
