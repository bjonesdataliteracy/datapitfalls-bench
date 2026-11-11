# Running the benchmark

A run replays a range of months. For each month it builds the as-of database, asks every question under every memory setup, and lets each setup carry its memory into the next month. See [PRD.md](PRD.md) for the design.

## Before you start

```bash
npm install && npm run build
python3 data/build_database.py --months 84 --end-month 2026-07   # about 40 minutes, 1.1 GB
```

A run needs free disk space for one as-of copy of the database at a time (about 1 GB). Copies are deleted after each month unless you pass `--keep-asof`.

## Dry run (free)

```bash
node dist/cli.js run --db data/bench.db --from 2026-02 --to 2026-07 --out runs/dry --dry-run
```

A dry run does everything a real run does except call a model: a scripted agent that returns the gold answers stands in, and Debrief reviews are skipped. It checks that every piece works on your database, and prints the size of each setup's opening prompt with a rough cost per session for three models.

**That cost is arithmetic on stated assumptions (requests per session, tokens per request), not a measurement.** Replace it with real numbers from a small live trial before budgeting a full run.

Other free agents, for checking the scorer: `--agent oracle` (always gold), `--agent naive` (the trap's answer whenever a question has a trap), `--agent stale` (last month's gold).

## Live run (paid)

```bash
export BENCH_ANTHROPIC_API_KEY=...   # or ANTHROPIC_API_KEY
node dist/cli.js run --db data/bench.db --from 2026-07 --to 2026-07 --out runs/trial \
  --only skywest-load-factor,domestic-passengers --setups none,pitfall --budget 2
```

- The key is read from `BENCH_ANTHROPIC_API_KEY` first, then from the SDK's usual variables. The separate name lets a machine hold a key for the benchmark without changing what other Anthropic tools on it use.
- `--budget` is required. Spend is estimated from each response's token usage and the price table in `src/pricing.ts`; when it reaches the budget, no new session starts and the run ends with exit code 2. Sessions already in flight finish, so the cap can be passed by up to `--concurrency` sessions.
- `--model` defaults to `claude-opus-5-5` and `--effort` to `medium`. A model with no row in the price table is refused, because it could not be capped.
- `--review-model` sets the model for Debrief reviews; it defaults to the agent's model, so a run involves one model.
- `--only`, `--setups` and a short month range keep a trial small. Start with one month and a few questions.
- Authentication, permission and bad-request errors stop the run. Rate limits and server errors are retried, and a session that still fails is recorded as unanswered.
- If the model declines a request, the session is recorded as unanswered. The harness does not fall back to another model, because the result would no longer measure the model named in the run.

## Score

```bash
node dist/cli.js score --run runs/trial
```

Writes `metrics.json` and `metrics.csv` into the run folder and prints a table per setup: accuracy, stale-answer rate, pitfall error rate, unanswered rate and tokens per question. When the run includes `debrief` with `cache` or `none`, it also prints the paired gate comparison with a bootstrap interval.

## What a run folder holds

| File | Contents |
| --- | --- |
| `config.json` | Everything the run was started with: months, setups, model, effort, review model, taxonomy version, seed |
| `gold.json` | Gold and trap answers for every question and month. **For scoring only; never show it to an agent** |
| `sessions.jsonl` | One line per session: answer, token usage, steps, and the full transcript in the shared Transcript schema |
| `memory/<setup>/<month>.json` | What each setup carried forward after each month, and what Debrief spent |
| `summary.json` | Sessions run, estimated spend, whether the budget stopped the run |
| `metrics.json`, `metrics.csv` | Written by `score` |

`runs/` is gitignored; publish results by copying the files you want to keep.

## Limits to know about

- The Claude adapter is tested against a fake client. Until a live trial is run, treat request shapes and prompts as unproven.
- Models take no sampling seed, so two runs of the same configuration will differ. `--seed` covers only the harness's own random choices.
- The paired comparison treats question-months as independent. The same questions repeat every month, so its interval is narrower than it should be.
- Debrief does not yet re-verify older memories, and reviews a sample of sessions, not all.
- There is no second model family yet (B10).
