# First live runs: trial and trap diagnostic (Nov 11, 2026)

Two small paid runs on `claude-opus-5-5` at medium effort, to prove the live path, measure cost and find out which traps catch the model. Total estimated spend: $1.81.

These are 16 and 68 sessions. They are enough to check that things work and to see large effects; they are not benchmark results.

## Run 1: trial

June and July 2026, four questions, the no-memory and Debrief setups: 16 agent sessions and 4 Debrief reviews. Estimated spend $0.62.

- **The live path works.** Every session queried the data and submitted an answer. No refusals, API errors or step-limit hits.
- **Debrief runs on `claude-opus-5-5`** through the datapitfalls engine (v0.12.0). Four reviews produced one lesson, citing `data-reality-gap`.
- **The agent saved no notes.** In the Debrief setup it had the `remember` tool and made zero notes in 8 sessions, including the month the standards were announced. The prompt only said it "can" save notes. It now says standards are announced once and should be saved. That change has not been tested live.

## Run 2: trap diagnostic

July 2026, all 34 questions, no memory, run twice: with no standards given (`--context-mode never`) and with all of them given (`--context-mode always`). Estimated spend $1.19.

| | No standards | All standards |
| --- | --- | --- |
| Accuracy, all 34 questions | 82.4% (28 of 34) | 97.1% (33 of 34) |
| The 23 controls | 23 correct | 23 correct |
| The 11 trap-adjacent questions | 5 correct, 5 pitfall errors, 1 wrong | 10 correct, 1 wrong |

By trap-adjacent question:

| Question | No standards | All standards |
| --- | --- | --- |
| `skywest-load-factor` | Correct | Correct |
| `domestic-load-factor` | Correct | Correct |
| `highest-load-factor-carrier` | Correct | Correct |
| `florida-departing-passengers` | Correct | Correct |
| `alaska-passengers-yoy` | Correct | Correct |
| `international-passengers-yoy` | Pitfall (−9.19% against −1.88%) | Correct |
| `total-passengers-yoy` | Pitfall | Correct |
| `washington-departing-passengers` | Pitfall | Correct |
| `alaska-or-envoy-fuller-planes` | Pitfall (AS against MQ) | Correct |
| `fastest-growing-airport` | Pitfall (SXQ) | Wrong (GYE; gold is COU) |
| `new-york-departing-passengers` | Wrong (5.0M against 6.3M) | Correct |

### What this shows

1. **Five of the eleven traps do not catch this model.** Without being told anything, it computed load factor as passengers over seats, counted Florida from the T-100 state column, and compared Alaska with Hawaiian included. Memory has nothing to add on these.
2. **The other six turn on a house rule, not on spotting the pitfall.** In its explanations the agent often named the problem unprompted ("late filings could make the drop smaller", "I applied no minimum size") and then gave the naive figure, because it had no way to know which convention this team uses. Given the rule, it applied it.
3. **So the room for memory is about 15 points, and all of it is remembering six rules.** That is the gap between 82% and 97%. Any setup that carries the memos forward should capture most of it. As built, on this model, the benchmark measures whether a setup keeps team decisions. It cannot yet separate pitfall-steered memory from plain note-keeping.
4. **One gold answer is open to challenge.** For `fastest-growing-airport` with standards given, the agent also applied the like-for-like carrier rule, because a growth ranking is a year-over-year comparison. The gold query does not. The standard's wording allows the agent's reading, so either the standard or the gold query should change.

Things that may be making the traps easy: the schema briefing in the system prompt points at the state columns and says class F is scheduled service, and the questions are worded precisely ("scheduled", "load factor").

## Measured cost

| Item | Measured |
| --- | --- |
| Agent session, all 34 questions, no memory | $0.0175 average (68 sessions); 2.5 model requests; the dearest session was $0.04 |
| Trap-adjacent questions | $0.022 average |
| Control questions | $0.015 average |
| Agent session in the Debrief setup | $0.025 average (8 sessions, 4 questions) |
| Debrief review | about $0.03, plus about $0.15 once a month to load the rule catalog |

Costs are estimated from token usage and the price table in `src/pricing.ts`, not read from a bill. The log-everything setup has not been run live; its extra cost is calculated from its prompt size.

Projected 6-month pilot, Debrief reviews included:

| Design | Sessions | Estimate |
| --- | --- | --- |
| 5 setups, 34 questions | 1,020 | about $23 |
| 4 setups, 34 questions | 816 | about $19 |
| 5 setups, 17 questions | 510 | about $13 |
| 4 setups, 17 questions | 408 | about $11 |
| 3 setups, 17 questions | 306 | about $9 |

A full 24-month run of 5 setups and 34 questions is roughly $100 to $150 per repeat, the upper end allowing for the log-everything prompt growing over two years.
