# Questions

`questions.yaml` holds the questions the benchmark asks every month of the replay, and how each is answered.

**Gold answers and trap answers are for scoring. Never show this file, or the output of the commands below, to an agent under test.**

## How a question works

| Field | Meaning |
| --- | --- |
| `id` | Stable kebab-case name |
| `category` | `level`, `trend`, `ranking`, `share` or `comparison` |
| `text` | What the agent is asked. `{latest_month}`, `{prior_year_month}`, `{previous_month}` and `{window_start}` are filled in each month |
| `answer` | `type` (`number`, `percent`, `entity` or `list`), a `unit`, and an optional `tolerance` |
| `gold_sql` | The query that gives the correct answer on the data visible that month |
| `standards` | The business rules the gold answer applies (see below) |
| `traps` | For trap-adjacent questions: a trap id from [`traps/catalog.yaml`](../traps/catalog.yaml) and the query someone who falls into that trap would run |

No model writes or checks a gold answer. Every answer comes from SQL run against the as-of data.

Queries can use these named parameters: `:t` (the newest visible month as `year * 12 + month - 1`), `:y` and `:m` (that month), `:py` and `:pm` (the same month a year earlier), `:ly` and `:lm` (the month before). "Scheduled" always means service class F.

## Trap answers

A trap-adjacent question has two answers each month: the gold one, and the one the trap's query produces. That lets the scorer separate three outcomes: correct, a pitfall error (the answer matches the trap query) and an ordinary miss. A trap is active only when the two answers differ and the month is inside the trap's window in the catalog.

## Standards

Some gold answers depend on a business rule, for example that load factor is total passengers over total seats, or that a city means its whole BTS market. These are listed under `standards`. They are not in the question text. The agent receives them through the business-context timeline (PRD 2, B4), each from the month it is introduced, so whether the agent still applies a rule months later is part of what the benchmark measures.

## Tolerances

| Answer | Default | Notes |
| --- | --- | --- |
| `number` | within 1% of gold | Ranks and counts of things set an exact tolerance |
| `percent` | within 0.5 percentage points | Shares use 0.25 |
| `entity` | exact code, ignoring case | A name returned next to the code is accepted too |
| `list` | same items, same order | |

## Commands

Build first (`npm run build`), and build the database with `data/build_database.py`.

```bash
# Every question for one month, with gold and trap answers
node dist/cli.js questions --db data/bench.db --as-of 2026-07

# Every question in every month: which are askable, which traps are active, how often gold changes
node dist/cli.js check --db data/bench.db --from 2024-08 --to 2026-07

# The database an agent is given for one month: later months are removed from the file
node dist/cli.js asof --db data/bench.db --as-of 2026-07 --out runs/asof-2026-07.db
```

Months are data months. `--simulated 2026-10` can replace `--as-of`: it gives the analyst's calendar month, and the newest visible data is three months earlier, matching BTS's release lag.

## Adding a question

1. Write the question, its `gold_sql` and, if it sits next to a trap, the trap's query.
2. `npm test` checks that every query is a read-only SELECT that compiles against the real schema, that trap ids exist in the catalog and that standards exist.
3. Run `check` against a built database. A question that has no gold answer in some month is reported and fails the check.

## Known limits

- 34 questions so far, of about 50 planned.
- No "why did this move?" questions yet; they have no single SQL answer.
- Four controls have the same gold answer in all 24 months, so they cannot show a stale answer.
- The year-over-year standard (count only carriers that filed in both months) removes late filers, but it also removes carriers that really stopped or started. It is listed as an open question in the PRD.
