# PRD 2: datapitfalls bench

> Part of the datapitfalls PRD set. Related specs: [PRD 1: datapitfalls core](https://github.com/bjonesdataliteracy/datapitfalls/blob/main/docs/prd/PRD-1-core.md) · [PRD 3: datapitfalls agent](https://github.com/bjonesdataliteracy/datapitfalls-agent/blob/main/docs/PRD.md)

## Summary

datapitfalls bench is a public, reproducible test of whether memory makes analytics agents more accurate when the data keeps changing. It replays real airline data month by month, without modifying it, and scores agents on accuracy, staleness and pitfalls.

**Problem.** Most agent memory research uses games, conversations and coding tasks. The nearest analytics work either tests memory within one conversation on fixed data, or simulates a company with planted problems and is not public (see [prior art](prior-art.md)). No open benchmark was found for analytics agents on real data that changes month to month, where cached answers go stale and definitions shift. Without that evidence, the datapitfalls agent is a claim.

**Users.** The maintainer (does the method work?); agent and BI vendors (how does our agent score?); researchers; readers of the findings.

**Goals.**

- Decide whether pitfall-steered memory with Debrief beats cached answers and no memory (the gate, below).
- Ship a harness any vendor can point their own agent at.
- Produce at least six publishable findings.

**Non-goals.** Not a general BI benchmark (SQL accuracy alone is covered elsewhere); no leaderboard hosting until v1.0; no modified data.

**Success metrics.**

| Metric | Target |
| --- | --- |
| Gate result | Pitfall memory with Debrief beats both cached answers and no memory by 10+ points of accuracy, or by 30% fewer pitfall errors (see The gate) |
| Reproducibility | Repeat runs of the same configuration land within 2 points of accuracy. Current models take no sampling seed, so a "seed" here means a repeat; the harness's own random choices are seeded |
| Outside adoption | 2 vendors or research groups run it by mid-2027 |
| Cost | Full run cost known after the pilot, then capped per setup |

## Benchmark design

Each simulated month, the agent sees only the data released by then, receives that month's business context, answers a fixed set of recurring questions, and carries memory forward according to its setup.

### The world

- **Data:** BTS T-100 segment and market tables plus OurAirports, never edited.
- **Replay:** 24 consecutive months, proposed as August 2024 to July 2026, with the database's earlier months (back to August 2019) kept as history for year-over-year questions. The "as-of" view hides months not yet published at that simulated date. BTS says T-100 data becomes public about 10 weeks after the month it covers, so the default as-of rule is a fixed release lag.
- **Limit of the replay:** the database holds each month as BTS served it on the day it was fetched, not as it first appeared. Late filing is still visible in the newest months of any fetch (see the catalog), so that trap bites at the end of the window without snapshots; to make it bite in every simulated month, the as-of view would need archived snapshots. Corrections to earlier months look rare: monthly passenger totals for February 2025 to July 2026 were identical in a copy built on 2026-10-15 and a fetch on 2026-11-10.
- **Snapshots:** the builder never re-downloads a cached file and records each file's hash and fetch time, so keeping `data/raw/` from each monthly build is the snapshot archive (B12).

### Trap catalog

Traps come from three sources; each is labeled with its start month, affected questions and rule IDs. The data traps below were found in the real data by the scanner and are in [`traps/catalog.yaml`](../traps/catalog.yaml), each with the SQL that shows it. Definition and goal traps are still proposals; they arrive with the business-context timeline (B4).

| Source | Trap | Rule IDs | Status |
| --- | --- | --- | --- |
| Data | Newest months are missing late-filing carriers and read as a drop | `partial-period-aggregation`, `uneven-aggregation-coverage` | In catalog |
| Data | Carrier stops reporting (Hawaiian after Dec 2025, Silver after Jun 2025); after a merger the volume continues under another code | `measurement-system-drift`, `uneven-aggregation-coverage` | In catalog |
| Data | Operating vs marketing carrier: regionals flying for a major | `data-reality-gap` | In catalog |
| Data | "Passengers" are boardings per flight, not travellers or trips; segment and market tables nearly agree | `data-reality-gap` | In catalog, reworded |
| Data | Average of row-level load factors instead of a weighted total | `unweighted-rate-average` | In catalog |
| Data | Join to OurAirports drops rows on code mismatches, nearly all of it one large airport | `join-key-mismatch-row-loss` | In catalog |
| Data | Tiny airports top a percent-growth ranking | `small-sample-extremes`, `divide-by-tiny-denominator` | In catalog |
| Data | One carrier leads on overall load factor but trails in every distance band | `simpsons-paradox` | In catalog |
| Data | A city is one airport or a multi-airport market | `uneven-aggregation-coverage`, `data-reality-gap` | In catalog |
| Definition | "Capacity" switches from seats to seat-miles | `measurement-system-drift`, `mismatched-units` | Proposed |
| Definition | A city's definition changes mid-series, for example from its main airport to the BTS city market (New York, Washington, Los Angeles) | `measurement-system-drift` | Proposed |
| Goal | Persona moves from network planner to investor; new cuts multiply | `multiple-comparisons`, `cherry-picked-chart-window` | Proposed |

Data traps are found by `data/scan_traps.py` (late filing, carriers that stop or start, join loss, tiny-base growth, rate averaging, segment against market, multi-airport cities, service-class mix, Simpson's reversals), then reviewed by hand. A trap enters the catalog only when it is found in the actual database.

Two earlier candidates changed on contact with the data. Segment and market passenger totals differ by only 0.5%, so "the segment table double-counts connections" was wrong as a contrast between the tables; the real trap is that both count boardings. And BTS's own Seattle city market holds SEA, Boeing Field and two seaplane bases, not Paine Field, so the city-definition trap now uses markets where the grouping matters.

The rule IDs above were checked against datapitfalls v0.12.0 (taxonomy version `8ecba93063d4`) and all exist; `divide-by-tiny-denominator` and `simpsons-paradox` are extension rules. `npm test` validates every catalog entry against the Trap schema and every `pitfall_ids` entry against the installed taxonomy, and fails on an unknown ID or an alias.

### Questions

- About 50 question templates asked every month: levels, trends, rankings, shares and comparisons. The first 34 are in [`questions/questions.yaml`](../questions/questions.yaml); every one has a gold answer in each of the 24 proposed months.
- Questions and gold answers are generated by script; gold answers are computed by SQL on that month's as-of data. No model writes or checks a gold answer.
- About a third are trap-adjacent (11 of the first 34); the rest are controls.
- **Trap answers.** A trap-adjacent question also carries the query an analyst who falls into the trap would run. The scorer can then tell a pitfall error (the answer matches the trap query) from an ordinary miss. A trap is active in a month only when its query gives a different answer from gold and the month is inside the trap's window in the catalog.
- **Standards.** Gold answers apply a short list of business rules (load factor is passengers over seats; year-over-year counts only carriers that filed in both months; a city means its BTS market). These rules reach the agent through the business-context timeline (B4), not the question text, so remembering them is part of what is measured.
- **Tolerances.** Counts and totals: within 1%. Percent answers: within 0.25 to 0.5 percentage points. Ranks and counts of things: exact. Entities: the code, or the name returned next to it. Lists: same items in the same order.
- Weighted toward details only the data reveals (specific routes, airports, months), so the model's prior knowledge of COVID or big mergers cannot substitute for memory.
- Not yet covered: "why did this move?" questions, which have no single SQL answer and need a scoring rule of their own.

### Setups compared

1. No memory (stateless baseline)
2. Log everything: every month's context, question, query and answer is kept and shown back
3. Cached answers: the last answer given to each question is shown back, with its month
4. Pitfall-steered memory: the agent is told what memory is for and saves its own notes, each citing a rule ID
5. Pitfall-steered memory plus Debrief: as 4, and after each month a sample of sessions is reviewed against the taxonomy with core's transcript review; solid findings become lessons

How a run works, and the choices behind it:

- **One session per question.** Each gets the month's as-of database through a SQL tool (one SELECT per call, 50 rows back, 30-second limit) and must submit one answer.
- **SQL only (decided Nov 11, 2026).** The agent has no Python and no charting. This matches agents that answer from a warehouse or semantic layer by writing SQL; it does not represent notebook-style agents that analyse in Python and draw charts. Results should be read as applying to SQL agents. It also means the Graphical Gaffes and Design Dangers rules are not exercised, and mistakes that are one line in a dataframe library are less likely here than in real work.
- **Sessions within a month are independent.** What a setup learns in a month becomes visible from the next month. Results do not depend on the order or timing of sessions, and sessions can run side by side.
- **Standards are announced once.** The context timeline ([`context/timeline.yaml`](../context/timeline.yaml)) gives each business rule in one month's memo. After that, applying it depends on memory. A second context mode, `always`, repeats every memo issued so far; it is the control that shows how much of a result is memory of the rules and how much is everything else.
- **Debrief in this version** reviews up to 12 sessions a month (those with failed queries first), keeps a few lessons per rule, and does not yet re-verify older memories.

**Model (decided Nov 11, 2026).** The pilot runs on one model: `claude-opus-5-5` at medium effort, for both the agent under test and the Debrief reviews, so a run involves a single model. A second model family is deferred until a general claim is published or vendors are invited to run the benchmark. Its purpose is to test whether the result generalises beyond one model, and to answer the fair concern that a harness developed against Claude favours Claude. Two limits on that: two models are a small sample, and Debrief's reviewer is the datapitfalls engine, which runs only on Claude, so setup 5 would still use a Claude reviewer.

"Log everything" is a serious baseline, not a strawman: other memory benchmarks report plain accumulated context beating dedicated memory systems, so its result is reported next to the gate comparison.

Sub-experiments: taxonomy as rules vs as purpose; one planted wrong memory, with and without Debrief; Debrief frequency (every session, weekly, monthly), since staleness elsewhere tracks how review timing compares with how fast the data changes.

### Metrics

| Metric | Definition |
| --- | --- |
| Accuracy | Share of answers within tolerance of gold |
| Stale-answer rate | Share of answers matching a previous month's gold but not this month's, judged from the answer given, not from whether memory was updated |
| Pitfall error rate | Share of trap-adjacent answers that fall into the labeled trap |
| Tokens per question | Input plus output tokens, including memory reads |
| Memory size | Lines in the preloaded index and total records, per month |
| Corruption spread | Answers affected by one planted wrong memory |

### The gate

The comparison is setup 5 (pitfall-steered memory plus Debrief) against setup 3 (cached answers) and against setup 1 (no memory), on the same questions, months and model. Setup 5 must clear the bar against both.

- **Bar:** 10+ points of accuracy, or 30% fewer pitfall errors.
- **Repeats (proposed):** at least 3 runs per setup. Models cannot be seeded, so repeats are the only way to see run-to-run noise. With about 50 questions a month and a third of them trap-adjacent, one run has roughly 400 trap-adjacent answers over 24 months, and the pitfall error rate from a single seed is too noisy to carry a go/no-go.
- **Decision rule (proposed):** paired differences per question and month, averaged across seeds, with a bootstrap 95% interval. The gate passes when the point estimate clears the bar and the interval excludes zero. Fix the rule before the first full run; do not adjust it after seeing results.
- **Reported either way:** all five setups, both model families, and every sub-experiment, including a miss.

### Cost

A full pass is 5 setups × 24 months × about 50 questions, or about 6,000 agent sessions per model family and seed. Two families and 3 seeds make about 36,000 sessions before sub-experiments and Debrief runs. The 6-month pilot (B8) measures cost per session; the seed count, question count and per-setup budget cap are set from that number, and the plan is cut to fit the budget before the full run, not during it.

## Requirements, harness and milestones

The harness is a TypeScript CLI over SQLite with pluggable agents and memory setups; P0 is everything the first gate needs.

| ID | Requirement | Priority |
| --- | --- | --- |
| B1 | As-of replay engine: given a simulated date, expose only the months published by then. Shipped: a separate as-of database file per month, so later months cannot be reached by any query | P0 |
| B2 | Trap catalog as YAML (Trap schema) plus the scanner that proposes data traps for review. First version shipped: scanner, ten data traps, catalog tests | P0 |
| B3 | Question templates with gold-answer SQL and tolerances, generated per month. First 34 of about 50 shipped | P0 |
| B4 | Business-context timeline: per-month definitions and persona. Shipped as one YAML file with dated memos and personas | P0 |
| B5 | Agent adapter interface; a Claude adapter with a read-only SQL tool. Shipped, with scripted agents for free end-to-end tests. The Claude adapter is tested against a fake client; it has not yet been run against the live API | P0 |
| B6 | Memory setups as plugins with `beforeSession`, `afterSession` and `nightly` hooks. All five shipped | P0 |
| B7 | Scorer for answer accuracy, staleness and pitfall errors, writing per-month metrics to JSON and CSV. Written in this repo: core's eval scoring measures findings, not answers, and is not a public export until core C9. Shipped, with the paired gate comparison | P0 |
| B8 | Cost guardrails: budget cap, dry run, 6-month pilot mode. Shipped: a required `--budget` that stops the run, `--dry-run`, and any month range | P0 |
| B9 | Deterministic config: seed, model ids (the agent's and the Debrief review engine's), effort, taxonomy version, datapitfalls and schemas versions, recorded with results. Shipped in each run's `config.json`, except package versions | P0 |
| B10 | Second model family adapter, to test whether results generalise beyond one model, and a "bring your own agent" HTTP adapter for vendors. Deferred until after the pilot | P1 |
| B11 | Results report generator (charts and tables for posts) | P1 |
| B12 | BTS release snapshot archiver | P1 |
| B13 | Public leaderboard page on avoidingdatapitfalls.com | P2 |

```bash
# Free: the whole harness with a scripted agent, plus prompt sizes and a rough cost
node dist/cli.js run --db data/bench.db --from 2026-02 --to 2026-07 --out runs/dry --dry-run

# Paid: stops when estimated spend reaches the budget
node dist/cli.js run --db data/bench.db --from 2026-02 --to 2026-07 --out runs/pilot \
  --model claude-opus-5-5 --effort medium --budget 50

node dist/cli.js score --run runs/pilot
```

The `--budget` figure is illustrative; real caps come from the pilot. The package is not on npm yet, so commands run from a checkout.

```text
datapitfalls-bench/
  data/        # SQLite build scripts (no edits to source data)
  traps/       # trap catalog YAML
  questions/   # templates + gold SQL
  context/     # monthly definitions and persona files
  setups/      # memory strategies (none, log-all, cache, pitfall, debrief)
  adapters/    # claude, second model, http
  runs/        # outputs, gitignored except published results
```

| Weeks | Milestone |
| --- | --- |
| 1 to 2 | Prior-art review (done, see [prior-art.md](prior-art.md)); database builder and trap scanner (done); catalog reviewed; spec frozen |
| 3 to 4 | Replay engine, first question set, context timeline, Claude adapter, five setups and scorer (done); a small live trial, then the 6-month pilot with a cost estimate |
| 5 to 6 | Full 24-month runs on two model families; sub-experiments |
| 7 to 8 | Results, write-up, public repo v1.0; gate decision |

**Open questions:**

- [ ] Which 24-month window? Proposed: August 2024 to July 2026. It holds the Hawaiian and Silver exits and the late-filing months, and most of it falls after current models' training cutoffs, so answers cannot come from prior knowledge. 2020 to 2021 has stronger breaks but every model knows about them.
- [ ] As-of dates: start from BTS's stated lag of about 10 weeks. The TranStats release page shows when months were added and updated; can its history be recovered for the chosen window, or only archived from now on?
- [x] Does the database hold final figures only? It holds each month as served on the fetch date. Late filing shows in the newest months; corrections to older months look rare (see The world).
- [x] Which model does the agent under test run on? `claude-opus-5-5` at medium effort for the pilot (see Setups compared).
- [ ] Is announce-once the right default for standards? It makes any memory that keeps the memos beat no memory by construction. The `always` mode is the control; the write-up should report both.
- [x] Which model does the Debrief review engine use? The same model as the agent, `claude-opus-5-5`, for the pilot. Not yet confirmed: that the datapitfalls engine (v0.12.0) runs cleanly on it; check in the first live trial. Core's own default is still under review (core PRD 1, C13).
- [ ] If Hex releases Metric City, run the same memory setups on it as a second, synthetic world?
- [x] What tolerance counts as correct for ratios and rankings? See Questions; revisit after the pilot shows how close agents land.
- [ ] How should "why did this move?" questions be scored?
- [ ] Is "count only carriers that filed in both months" the right standard for year-over-year figures? It removes late filers, but it also removes carriers that really stopped or started.
- [ ] License for question and trap content: MIT with the code, or CC BY?
- [x] Do agents get only a SQL tool, or charting too? SQL only for now (see Setups compared). A Python or charting tool would need a sandbox for the agent's code and a way to keep the as-of restriction airtight.
