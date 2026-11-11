# Deliverables exploration (Nov 11, 2026)

A first look at whether an agent commits the judgment and design pitfalls when it is asked for a chart and a written takeaway instead of a single number. Not part of the scored benchmark.

**Setup.** Twelve briefs ([`briefs/briefs.yaml`](../briefs/briefs.yaml)), data as of July 2026, `claude-opus-5-5` at medium effort with no memory. The agent queried with SQL, drew with Python in Anthropic's hosted sandbox, and submitted a chart, a title and a takeaway. Each result was reviewed by the datapitfalls engine (v0.12.0, whole-chain mode, on `claude-opus-5-5`). Estimated spend about $4.10, sandbox time not included.

**Read this as a pilot of the method.** Twelve deliverables, one model, one run each, graded by the project's own engine and spot-checked by one reader. The counts below are the engine's, not verified findings.

## What came back

All twelve briefs produced a chart and a takeaway. Eleven were reviewed; one review failed ("the model did not return a report").

| Domain | Findings |
| --- | --- |
| Epistemic Errors | 11 |
| Graphical Gaffes | 9 |
| Mathematical Miscues | 5 |
| Statistical Slip-Ups | 3 |
| Technical Trespasses | 2 |
| Analytical Aberrations | 2 |
| Design Dangers | 0 |

Most frequent rules: `data-reality-gap` (6), `chart-omits-key-context` (4), `inductive-overreach` (3), `partial-period-aggregation` (3).

## What held up on inspection

- **A truncated bar axis.** The load-factor ranking draws bars from 70%, and its own footnote says so.
- **A cherry-picked baseline under an advocacy brief.** Asked to make the case that international travel is recovering, the agent compared every month with one peak-season month (August 2019) and titled the chart "fully recovered". It did disclose the late filers.
- **Data stated as fact about the world.** The Spirit chart's takeaway says "this is Spirit's flying stopping, not a reporting gap", reasoning that other carriers are fully reported for those months. They are not: more than a dozen carriers have not filed.
- **"Demand" and "people" language** for what are boardings on flights that operated (several briefs).
- **A "likely range" that is not one.** The forecast's range is the best and worst single month applied to the rest of the year.
- **Uneven comparisons in a success story.** Breeze's load-factor gain compares a start-up half-year with a later peak period.

## What the agent got right unprompted

It combined Alaska and Hawaiian, flagged late filers, used the median for the "typical route", put a size floor on the growth ranking, computed load factor from totals, and explained operating carriers. The charts themselves were clean: readable, labelled, consistent in colour.

## What this suggests

1. **The headroom is in the prose and the titles, not the arithmetic or the styling.** Overclaiming, treating records as reality, and advocacy framing are where this model slips.
2. **Classic chart gaffes are rare.** One truncated axis in twelve charts, and no Design Dangers findings. A benchmark aimed at visual mistakes would likely hit a ceiling on this model unless briefs push harder or a weaker model is tested.
3. **Advocacy briefs draw out more.** The "make the case" brief had nine findings; the neutral ones had one to five.

## Problems with the reviewer

- **Run-to-run variance.** The Spirit brief was run twice: one review gave five findings, the other one.
- **Speculative padding.** Several low-confidence, latent findings (possible duplicate carrier names, possible embedded totals) had no evidence behind them.
- **Misses.** It did not catch the false premise in the Spirit takeaway, or the unsorted bars in one dashboard panel.
- **One review failed outright.**

A scored version would need repeated reviews, a confidence floor, and human ratings to calibrate against.

## Cost

About $0.08 to $0.24 per deliverable for the agent and about $0.06 per review. One brief, the four-panel dashboard, cost $1.72 because the sandbox turn wrote about 300,000 tokens to cache; that needs a guard before any larger run.
