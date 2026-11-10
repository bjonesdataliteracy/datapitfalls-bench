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
| Reproducibility | A rerun with the same seed lands within 2 points of accuracy |
| Outside adoption | 2 vendors or research groups run it by mid-2027 |
| Cost | Full run cost known after the pilot, then capped per setup |

## Benchmark design

Each simulated month, the agent sees only the data released by then, receives that month's business context, answers a fixed set of recurring questions, and carries memory forward according to its setup.

### The world

- **Data:** BTS T-100 segment and market tables plus OurAirports, never edited.
- **Replay:** 24 consecutive months. The "as-of" view hides months not yet published at that simulated date. BTS says T-100 data becomes public about 10 weeks after the month it covers, so the default as-of rule is a fixed release lag.
- **Limit of the replay:** a database of final figures can hide a month, but it cannot show a month as it first appeared (partly reported, or before a carrier's correction). Traps that depend on as-released values need archived snapshots; until then they are marked "needs snapshots" in the catalog and left out of the gate.
- **Snapshots:** archive each monthly BTS release from now on, so real revisions can be measured in v1.1.

### Trap catalog

Traps come from three sources; each is labeled with its start month, affected questions and rule IDs.

| Source | Example trap | Likely rule IDs |
| --- | --- | --- |
| Data | Latest month only partly reported, read as a drop (needs snapshots unless the database holds a partial month) | `partial-period-aggregation` |
| Data | Carrier stops reporting after a merger; volume moves to another code | `measurement-system-drift`, `uneven-aggregation-coverage` |
| Data | Operating vs marketing carrier: regionals flying for a major | `data-reality-gap` |
| Data | Segment table counts connecting passengers once per leg; joining segment to market rows multiplies them | `data-reality-gap`, `join-fan-out` |
| Data | Average of route load factors instead of a weighted total | `unweighted-rate-average` |
| Data | Join to OurAirports drops rows on code mismatches | `join-key-mismatch-row-loss` |
| Data | Tiny airports top a percent-growth ranking | `small-sample-extremes`, `divide-by-tiny-denominator` |
| Data | A carrier's overall trend reverses once split by airport or route mix (candidate; confirm in the data) | `simpsons-paradox` |
| Definition | "Capacity" switches from seats to seat-miles | `measurement-system-drift`, `mismatched-units` |
| Definition | "Seattle" grows from SEA to SEA plus Paine Field | `measurement-system-drift` |
| Goal | Persona moves from network planner to investor; new cuts multiply | `multiple-comparisons`, `cherry-picked-chart-window` |

Data traps are found by automated scans (reporting starts and stops, jumps beyond a threshold, join loss, revisions), then reviewed by hand. A trap enters the catalog only when the scanner or a hand check finds it in the actual database; the rows above are candidates until then.

The rule IDs above were checked against datapitfalls v0.12.0 (taxonomy version `8ecba93063d4`) and all exist; `join-fan-out`, `divide-by-tiny-denominator` and `simpsons-paradox` are extension rules. The harness validates every `pitfall_ids` entry against the installed taxonomy, resolving aliases, and fails on an unknown ID.

### Questions

- About 50 question templates asked every month: trends, rankings, shares, comparisons and "why did this move?"
- Questions and gold answers are generated by script; gold answers are computed by SQL on that month's as-of data, with tolerances. No model writes or checks a gold answer.
- About a third are trap-adjacent; the rest are controls.
- Weighted toward details only the data reveals (specific routes, airports, months), so the model's prior knowledge of COVID or big mergers cannot substitute for memory.

### Setups compared

1. No memory (stateless baseline)
2. Log everything (every answer and finding saved)
3. Cached answers (question-to-answer store)
4. Pitfall-steered memory (taxonomy given as the purpose of memory)
5. Pitfall-steered memory plus Debrief (nightly review and re-verification)

Run on Claude and at least one other model family. "Log everything" is a serious baseline, not a strawman: other memory benchmarks report plain accumulated context beating dedicated memory systems, so its result is reported next to the gate comparison.

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
- **Seeds (proposed):** at least 3 seeds per setup. With about 50 questions a month and a third of them trap-adjacent, one run has roughly 400 trap-adjacent answers over 24 months, and the pitfall error rate from a single seed is too noisy to carry a go/no-go.
- **Decision rule (proposed):** paired differences per question and month, averaged across seeds, with a bootstrap 95% interval. The gate passes when the point estimate clears the bar and the interval excludes zero. Fix the rule before the first full run; do not adjust it after seeing results.
- **Reported either way:** all five setups, both model families, and every sub-experiment, including a miss.

### Cost

A full pass is 5 setups × 24 months × about 50 questions, or about 6,000 agent sessions per model family and seed. Two families and 3 seeds make about 36,000 sessions before sub-experiments and Debrief runs. The 6-month pilot (B8) measures cost per session; the seed count, question count and per-setup budget cap are set from that number, and the plan is cut to fit the budget before the full run, not during it.

## Requirements, harness and milestones

The harness is a TypeScript CLI over SQLite with pluggable agents and memory setups; P0 is everything the first gate needs.

| ID | Requirement | Priority |
| --- | --- | --- |
| B1 | As-of replay engine: given a simulated date, expose only the months published by then | P0 |
| B2 | Trap catalog as YAML (Trap schema) plus the scanner that proposes data traps for review | P0 |
| B3 | Question templates with gold-answer SQL and tolerances, generated per month | P0 |
| B4 | Business-context timeline: per-month markdown for definitions and persona | P0 |
| B5 | Agent adapter interface; a Claude adapter with a read-only SQL tool | P0 |
| B6 | Memory setups as plugins with `beforeSession`, `afterSession` and `nightly` hooks | P0 |
| B7 | Scorer for answer accuracy, staleness and pitfall errors, writing per-month metrics to JSON and CSV. Written in this repo: core's eval scoring measures findings, not answers, and is not a public export until core C9 | P0 |
| B8 | Cost guardrails: budget cap, dry run, 6-month pilot mode | P0 |
| B9 | Deterministic config: seed, model ids (the agent's and the Debrief review engine's), effort, taxonomy version, datapitfalls and schemas versions, recorded with results | P0 |
| B10 | Second model family adapter, and a "bring your own agent" HTTP adapter for vendors | P1 |
| B11 | Results report generator (charts and tables for posts) | P1 |
| B12 | BTS release snapshot archiver | P1 |
| B13 | Public leaderboard page on avoidingdatapitfalls.com | P2 |

```bash
npx @datapitfalls/bench run --setup debrief --model claude-sonnet-5-5 \
  --months 2023-01:2024-12 --seed 7 --budget 150
npx @datapitfalls/bench score runs/2026-12-01-debrief
```

The `--budget` figure is illustrative; real caps come from the pilot.

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
| 1 to 2 | Prior-art review (done, see [prior-art.md](prior-art.md)); spec frozen; trap scanner run; catalog reviewed |
| 3 to 4 | Harness, Claude adapter, five setups; 6-month pilot with cost estimate |
| 5 to 6 | Full 24-month runs on two model families; sub-experiments |
| 7 to 8 | Results, write-up, public repo v1.0; gate decision |

**Open questions:**

- [ ] Which 24-month window? Including 2020 to 2021 adds strong traps but also strong model priors.
- [ ] As-of dates: start from BTS's stated lag of about 10 weeks. The TranStats release page shows when months were added and updated; can its history be recovered for the chosen window, or only archived from now on?
- [ ] Does the supplied database hold final figures only? If so, which candidate traps survive without snapshots?
- [ ] Which model does the Debrief review engine use? Core's default is under review (core PRD 1, C13); settle it before the pilot and keep it fixed through the runs.
- [ ] If Hex releases Metric City, run the same memory setups on it as a second, synthetic world?
- [ ] What tolerance counts as correct for ratios and rankings?
- [ ] License for question and trap content: MIT with the code, or CC BY?
- [ ] Do agents get only a SQL tool, or charting too (to exercise the Graphical Gaffes rules)?
