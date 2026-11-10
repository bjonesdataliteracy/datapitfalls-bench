// Runs every trap's evidence_query against the bench database, read-only, and
// prints the first rows, so a reviewer can see each trap in the data.
// Usage: npm run check:evidence -- --db data/bench.db [--id trap-id] [--rows 12]
// Needs Node 22.5+ (node:sqlite).
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const dbPath = arg('db', 'data/bench.db');
const only = arg('id');
const maxRows = Number(arg('rows', 12));

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Build it with data/build_database.py.`);
  process.exit(1);
}
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('This script needs Node 22.5 or newer (node:sqlite).');
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const catalog = yaml.load(readFileSync(new URL('../traps/catalog.yaml', import.meta.url), 'utf8'));
let failed = 0;
for (const trap of catalog) {
  if (only && trap.id !== only) continue;
  if (!trap.evidence_query) continue;
  console.log(`\n== ${trap.id}  [${trap.pitfall_ids.join(', ')}]`);
  try {
    const rows = db.prepare(trap.evidence_query).all();
    if (rows.length === 0) {
      failed += 1;
      console.log('   NO ROWS: the trap is not visible in this database.');
      continue;
    }
    console.table(rows.slice(0, maxRows));
    if (rows.length > maxRows) console.log(`   ... ${rows.length - maxRows} more rows`);
  } catch (error) {
    failed += 1;
    console.log(`   QUERY FAILED: ${error.message}`);
  }
}
db.close();
process.exit(failed ? 1 : 0);
