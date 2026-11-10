# Benchmark data

The benchmark runs on a SQLite database built from two public-domain sources. Nothing in it is edited, filtered or aggregated.

| Table | Source | Notes |
| --- | --- | --- |
| `segments` | [BTS T-100 Segment](https://www.transtats.bts.gov/), domestic and international | One row per carrier, nonstop leg, aircraft type, service class and month |
| `markets` | BTS T-100 Market, domestic and international | One row per carrier, on-flight market, service class and month |
| `carriers`, `aircraft_types`, `service_classes` | BTS lookup tables | |
| `airports`, `countries` | [OurAirports](https://github.com/davidmegginson/ourairports-data) | Global, including closed airports |
| `source_files` | written by the builder | One row per input file: row count, SHA-256 and when it was fetched |

Segment and market rows share carrier, airport, city-market and class columns, so the two can be compared directly. State columns are filled only for domestic rows and country columns only for international rows, because that is how BTS publishes them.

## Build it

Python 3.9+ and the standard library only.

```bash
python3 data/build_database.py --months 24 --end-month 2026-07
```

This writes `data/bench.db` and caches every download under `data/raw/`. Both are gitignored. BTS has no API, so the builder posts to the TranStats download form, one request at a time: four requests per month, about half a minute per month.

A file already in `data/raw/` is never downloaded again. That makes `data/raw/` the record of what BTS served on the day each file was fetched, which matters because BTS revises earlier months. To rebuild from the cache with no network:

```bash
python3 data/build_database.py --from-raw
```

If the BTS form changes, the build fails with a specific message. Files downloaded by hand from TranStats (Aviation, Air Carrier Statistics, "Select all fields") can be dropped into `data/raw/` under the names the builder uses, for example `t100_segment_domestic_2026_07.csv`.

## Test it

```bash
python3 data/tests/test_builder.py
```

The tests use the tiny files in `data/tests/fixtures/`, whose rows are labeled `FIXTURE` and dated 2099. They never touch the network.

## Credit

Data: U.S. Bureau of Transportation Statistics, T-100 Segment and Market (public domain), and OurAirports (public domain). The builder is adapted from the SQLiteracy teaching-database pipeline by Data Literacy.
