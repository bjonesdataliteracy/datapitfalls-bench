# Trap catalog

`catalog.yaml` lists the traps the benchmark scores: places where the real, unmodified data is likely to lead an analyst or agent into a known pitfall. Each entry follows the Trap contract in [`@datapitfalls/schemas`](https://www.npmjs.com/package/@datapitfalls/schemas) and cites at least one [Avoiding Data Pitfalls](https://www.avoidingdatapitfalls.com) rule id.

## How a trap gets in

1. **Scan.** `python3 data/scan_traps.py --from 2024-08 --to 2026-07` reads the bench database and prints candidates with the numbers behind them. Add `--json scan.json` for the full detail.
2. **Review.** A person checks each candidate against the data and decides whether it is a real trap or noise.
3. **Write it down.** Add an entry with a plain-words `ground_truth` and an `evidence_query` that shows the trap.
4. **Check.** `npm test` validates the catalog against the schema and the taxonomy. `npm run check:evidence -- --db data/bench.db` runs every evidence query and prints the rows (Node 22.5+).

Nothing is planted. If a trap stops showing up after a data refresh, its evidence query returns no rows and the check fails.

## Fields

| Field | Meaning here |
| --- | --- |
| `id` | Stable kebab-case name |
| `kind` | `data` (in the data itself), `definition` (a business definition changes) or `goal` (the analytical goal changes) |
| `start_month`, `end_month` | Data months, `YYYY-MM`: the first and last month of data in which the trap is present. No `end_month` means it runs to the end of the window |
| `pitfall_ids` | Current rule ids from the taxonomy; aliases are rejected |
| `affected_questions` | Question ids that touch the trap. Empty until the question set exists (B3) |
| `ground_truth` | What is really going on, with the figures |
| `evidence_query` | Read-only SQL against the bench database that shows it |

## What the figures depend on

The figures in `ground_truth` come from data fetched on 2026-11-10. Late-filing carriers will fill in later, so a rebuild from a fresh fetch will show different numbers for the newest months. Rebuild from the same `data/raw/` cache to reproduce them exactly.
