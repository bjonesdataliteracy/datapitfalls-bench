# PRD 2: datapitfalls bench

> Part of the datapitfalls PRD set. Related specs: [PRD 1: datapitfalls core](https://github.com/bjonesdataliteracy/datapitfalls/blob/main/docs/prd/PRD-1-core.md) · [PRD 3: datapitfalls agent](https://github.com/bjonesdataliteracy/datapitfalls-agent/blob/main/docs/PRD.md)

## Summary

datapitfalls bench is a public, reproducible test of whether memory makes analytics agents more accurate when the data keeps changing. It replays real airline data month by month, without modifying it, and scores agents on accuracy, staleness and pitfalls.

**Problem.** Agent memory research uses games and document corpora. Nobody has published evidence for analytics agents working on live business data, where cached answers go stale and definitions shift. Without evidence, the datapitfalls agent is a claim.

**Users.** The maintainer (does the method work?); agent and BI vendors (how does our agent score?); researchers; readers of the findings.

**Goals.**

- Decide whether pitfall-steered memory with Debrief beats cached answers and no memory.
- Ship a harness any vendor can point their own agent at.
- Produce at least six publishable findings.

**Non-goals.** Not a general BI benchmark (SQL accuracy alone is covered elsewhere); no leaderboard hosting until v1.0; no modified data.

**Success metrics.**

| Metric | Target |
| --- | --- |
| Gate result | Pitfall memory with Debrief: 10+ points accuracy or 30% fewer pitfall errors vs cached answers |
| Reproducibility | A rerun with the same seed lands within 2 points |
| Outside adoption | 2 vendors or research groups run it by mid-2027 |
| Cost | Full run cost known after the pilot, then capped per setup |

## Benchmark design

Each simulated month, the agent sees only the data released by then, receives that month's business context, answers a fixed set of recurring questions, and carries memory forward according to its setup.

### The world

- **Data:** BTS T-100 segment and market tables plus OurAirports, never edited.
- **Replay:** 24 consecutive months. The "as-of" view hides months not yet published at that simulated date, so late and partial months look as they did to a real analyst.
- **Snapshots:** archive each monthly BTS release from now on, so real revisions can be measured in v1.1.

### Trap catalog

Traps come from three sources; each is labeled with its start month, affected questions and rule IDs.

| Source | Example trap | Likely rule IDs |
| --- | --- | --- |
| Data | Latest month only partly reported, read as a drop | `partial-period-aggregation` |
| Data | Carrier stops reporting after a merger; volume moves to another code | `measurement-system-drift`, `uneven-aggregation-coverage` |
| Data | Operating vs marketing carrier: regionals flying for a major | `data-reality-gap` |
| Data | Segment table counts connecting passengers once per leg | `data-reality-gap` |
| Data | Average of route load factors instead of a weighted total | `unweighted-rate-average` |
| Data | Join to OurAirports drops rows on code mismatches | `join-key-mismatch-row-loss` |
| Data | Tiny airports top a percent-growth ranking | `small-sample-extremes` |
| Definition | "Capacity" switches from seats to seat-miles | `measurement-system-drift`, `mismatched-units` |
| Definition | "Seattle" grows from SEA to SEA plus Paine Field | `measurement-system-drift` |
| Goal | Persona moves from network planner to investor; new cuts multiply | `multiple-comparisons`, `cherry-picked-chart-window` |

Data traps are found by automated scans (reporting starts and stops, jumps beyond a threshold, join loss, revisions), then reviewed by hand. Verify every rule ID against the taxonomy, including extension rules.

### Questions

- About 50 question templates asked every month: trends, rankings, shares, comparisons and "why did this move?"
- Gold answers computed by SQL on that month's as-of data, with tolerances.
- About a third are trap-adjacent; the rest are controls.
- Weighted toward details only the data reveals (specific routes, airports, months), so the model's prior knowledge of COVID or big mergers cannot substitute for memory.

### Setups compared

1. No memory (stateless baseline)
2. Log everything (every answer and finding saved)
3. Cached answers (question-to-answer store)
4. Pitfall-steered memory (taxonomy given as the purpose of memory)
5. Pitfall-steered memory plus Debrief (nightly review and re-verification)

Run on Claude and at least one other model family. Sub-experiments: taxonomy as rules vs as purpose; one planted wrong memory, with and without Debrief.

### Metrics

| Metric | Definition |
| --- | --- |
| Accuracy | Share of answers within tolerance of gold |
| Stale-answer rate | Share of answers matching a previous month's gold but not this month's |
| Pitfall error rate | Share of trap-adjacent answers that fall into the labeled trap |
| Tokens per question | Input plus output tokens, including memory reads |
| Memory size | Lines in the preloaded index and total records, per month |
| Corruption spread | Answers affected by one planted wrong memory |

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
| B7 | Scorer (reusing core eval scoring) writing per-month metrics to JSON and CSV | P0 |
| B8 | Cost guardrails: budget cap, dry run, 6-month pilot mode | P0 |
| B9 | Deterministic config: seed, model ids, effort, taxonomy version, recorded with results | P0 |
| B10 | Second model family adapter, and a "bring your own agent" HTTP adapter for vendors | P1 |
| B11 | Results report generator (charts and tables for posts) | P1 |
| B12 | BTS release snapshot archiver | P1 |
| B13 | Public leaderboard page on avoidingdatapitfalls.com | P2 |

```bash
npx @datapitfalls/bench run --setup debrief --model claude-sonnet-5-5 \
  --months 2023-01:2024-12 --seed 7 --budget 150
npx @datapitfalls/bench score runs/2026-12-01-debrief
```

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
| 1 to 2 | Spec frozen; trap scanner run; catalog reviewed |
| 3 to 4 | Harness, Claude adapter, five setups; 6-month pilot with cost estimate |
| 5 to 6 | Full 24-month runs on two model families; sub-experiments |
| 7 to 8 | Results, write-up, public repo v1.0; gate decision |

**Open questions:**

- [ ] Which 24-month window? Including 2020 to 2021 adds strong traps but also strong model priors.
- [ ] Is a BTS publication calendar available, or must as-of dates be inferred from release lag?
- [ ] What tolerance counts as correct for ratios and rankings?
- [ ] License for question and trap content: MIT with the code, or CC BY?
- [ ] Do agents get only a SQL tool, or charting too (to exercise the Graphical Gaffes rules)?
