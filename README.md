# datapitfalls bench

**Does memory make AI analytics agents better when the data keeps changing?**

datapitfalls bench is an open, reproducible benchmark that answers that question. It replays real U.S. airline data (BTS T-100 plus OurAirports) month by month, never modifying it, and scores analytics agents on:

- **Accuracy** against SQL-computed gold answers
- **Staleness**: answers that were right last month but wrong now
- **Pitfalls**: falling into labeled traps from the [Avoiding Data Pitfalls](https://www.avoidingdatapitfalls.com) taxonomy
- **Cost**: tokens per question, including memory reads

The traps are real, not planted: partial months, carriers that stop reporting after mergers, operating vs marketing carriers, segment-level double counting, shifting business definitions and changing analytical goals.

## Status

🚧 **Pre-release.** The design is in [docs/PRD.md](docs/PRD.md). The harness is being built in the open; follow along or open an issue with ideas.

Built so far: the [database builder](data/README.md), the [trap scanner and trap catalog](traps/README.md), the as-of replay engine, the [first question set](questions/README.md), the business-context timeline, a Claude adapter, five memory setups, the scorer and the [runner](docs/running.md). Two small live runs have checked that it works and measured its cost ([notes](docs/live-trial-2026-11.md)); there are no benchmark results yet.

## Part of the datapitfalls family

| Project | What it does |
| --- | --- |
| [datapitfalls](https://github.com/bjonesdataliteracy/datapitfalls) | The rules: 78-rule taxonomy, CLI, MCP connector |
| **datapitfalls bench** | This repo: the benchmark |
| [datapitfalls agent](https://github.com/bjonesdataliteracy/datapitfalls-agent) | The reviewer that remembers |

## License

Code is [MIT](LICENSE). Pitfall rule IDs refer to the Avoiding Data Pitfalls taxonomy, licensed separately under CC BY-NC 4.0 (see the [datapitfalls repo](https://github.com/bjonesdataliteracy/datapitfalls/blob/main/LICENSE-TAXONOMY.md)).

Based on *Avoiding Data Pitfalls* by Ben Jones (Wiley, 2019). Made by [Data Literacy](https://dataliteracy.com).
