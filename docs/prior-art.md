# Prior art: is there already a benchmark like this?

Reviewed Nov 9, 2026. Question from the plan's week 1: does a public benchmark for analytics-agent memory on changing data already exist?

**Short answer:** no public one was found, but one unreleased vendor benchmark is close, and several public benchmarks cover one piece each. The claim datapitfalls bench can make is narrower than "nobody has done this".

**How this was done, and its limits.** About a dozen web searches across arXiv listings, vendor blogs and secondary write-ups. The entries below come from abstracts and search summaries; none of the papers was read in full, and the Hex details come from third-party write-ups of a talk, not from Hex. Treat the numbers as leads to check before quoting them in public. Re-run this review before the results are published.

## Closest work

| Work | What it is | Overlap with bench | What it lacks for our question |
| --- | --- | --- | --- |
| Hex "Metric City" (2026, unreleased) | A 90-day simulation of a fictional company: a messy warehouse with hand-injected data quality problems, stakeholder tickets, and an optional knowledge-work turn after each task. Reported at roughly 4% on day 0 and 24% on day 90 for one model | The nearest match: analytics agent, long horizon, accumulated knowledge, data quality problems | Not public (an intent to open-source was reported; no release found). Synthetic data with planted problems. Run by a vendor on its own design. No comparison of memory setups, and no pitfall taxonomy |
| [EnterpriseMem-Bench](https://arxiv.org/abs/2605.26394v1) (May 2026) | 300 sessions and 1,400 turns of multi-turn text-to-SQL over three enterprise datasets, built by a deterministic script, comparing memory architectures | Analytics-style questions, SQL gold answers, memory setups compared, public code | Memory inside one conversation, not across months. The data does not change. Scores SQL execution accuracy, not reasoning pitfalls |
| [ChurnBench](https://arxiv.org/abs/2609.11515) (Sep 2026) | A generated enterprise data environment that drifts along a timeline, with a ground-truth ledger, measuring stale answers from cached retrieval | Changing data, staleness as a metric, public code | Retrieval and caching, not analysis. Synthetic data. No memory of lessons or decisions |
| [STALE](https://arxiv.org/abs/2605.06527) (May 2026) | 400 scenarios testing whether an agent notices a stored memory is no longer valid | Stale memory as the failure to measure | Everyday conversational topics, not data work |
| [Continual Learning Bench](https://arxiv.org/abs/2606.05661) (Jun 2026) | Task sequences in six domains, some with data analysis, testing whether agents improve with experience | Learning across sessions; compares memory systems to plain in-context learning | Not one evolving dataset; no business definitions or pitfall labels |
| [EvoArena](https://arxiv.org/abs/2606.13681) (Jun 2026) | Terminal, coding and persona benchmarks whose environments change over a chain of steps | Memory under a changing environment | Not analytics |
| [BIRD-Interact](https://arxiv.org/abs/2510.05318) / LiveSQLBench | Interactive text-to-SQL with a knowledge base and changing database state within a task | Business knowledge needed to answer; state changes | Single task, no carry-over between sessions |
| [EvoSchema](https://www.vldb.org/pvldb/vol18/p3655-zhang.pdf) (VLDB) | Text-to-SQL robustness when the schema changes | Change over time as the stressor | Schema changes only; no memory |
| DABstep, DSBench, InsightBench, InfiAgent-DABench | Data-analysis agent benchmarks on fixed datasets | Analytics tasks with gold answers | One-shot: no memory, no change over time |

The benchmark's motivation, Anthropic's [components of agent memory](https://anthropic.com/research/components-of-agent-memory) post (Nov 2026), studies memory in a game and on Continual Learning Bench, not on business data. Secondary write-ups note that its game comparison rests on single runs.

## What is still open

No public benchmark was found that combines all of these:

1. An analytics agent answering business questions with SQL.
2. Real public data, replayed in time order and never modified.
3. Traps that occur naturally and are labeled with a published pitfall taxonomy.
4. Changing business definitions and goals alongside the changing data.
5. A like-for-like comparison of memory setups, including an offline review pass.

Metric City covers 1 and parts of 3 and 5, with synthetic data and no public release. That is the comparison readers will make, so the write-up should name it.

## What to say, and not say

- **Don't say** "nobody has published evidence on memory for analytics agents." EnterpriseMem-Bench has, within a conversation, and Hex has shown results from Metric City.
- **Do say** that bench is, as far as this review found, the first open benchmark of analytics-agent memory on real data that changes month to month, with naturally occurring, taxonomy-labeled traps.
- If Hex releases Metric City, treat it as a complement (synthetic and controlled, against real and uncontrolled) and consider running the same memory setups on both.

## Lessons taken into the design

| Finding elsewhere | Change in PRD 2 |
| --- | --- |
| Continual Learning Bench reports plain in-context learning beating dedicated memory systems | Keep "log everything" as a serious baseline, not a strawman, and report it next to the gate comparison |
| ChurnBench finds staleness depends on refresh timing relative to how fast each thing changes, not on cache age | Add a sub-experiment on Debrief frequency |
| STALE finds models can recognize a memory is outdated yet still act on it | Score stale answers from what the agent answers, not from whether its memory was updated |
| EnterpriseMem-Bench builds questions and gold SQL with a deterministic script and no model in the loop | Generate questions and gold answers by script; no model writes gold answers |
| The Anthropic game comparison is reported as single runs | Several seeds per setup, and a gate rule that accounts for run-to-run noise |

## Facts about the data source found along the way

- BTS says T-100 data becomes public [about 10 weeks after the month it covers](https://www.bts.gov/learn-about-bts-and-our-work/statistical-methods-and-policies/aviation-revenue-passenger-miles).
- The [TranStats release page](https://www.transtats.bts.gov/releaseinfo.asp) lists when each month was added and when earlier months were "updated", so revisions do happen. What changed in each update is not stated there.
- BTS notes that carriers can misreport and that BTS cannot change carrier-submitted figures itself, so corrections arrive as carrier resubmissions.

No formal schedule of preliminary and final T-100 data was found.
