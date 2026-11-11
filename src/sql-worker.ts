// Runs one read-only query in its own process, so the parent can kill it if
// it runs too long. (A worker thread cannot be stopped while SQLite is busy
// inside a single long query; a process can.)
import { DatabaseSync } from 'node:sqlite';
import { runReadOnlyQuery } from './replay.js';

process.once('message', (job: { dbPath: string; sql: string; maxRows: number }) => {
  let reply: { ok: boolean; result?: unknown; error?: string };
  try {
    const db = new DatabaseSync(job.dbPath, { readOnly: true });
    try {
      reply = { ok: true, result: runReadOnlyQuery(db, job.sql, job.maxRows) };
    } finally {
      db.close();
    }
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.send?.(reply, () => process.exit(0));
});
