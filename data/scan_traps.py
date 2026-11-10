"""
datapitfalls bench: trap scanner (PRD 2, B2)
============================================
Reads the benchmark database and proposes data traps: places where the
real, unmodified data is likely to lead an analyst or agent into a known
pitfall. The scanner only reads; it never changes the data.

Every check returns candidates with the numbers behind them and the
Avoiding Data Pitfalls rule ids that apply. Candidates are proposals: a
person reviews them and writes the ones worth keeping into
traps/catalog.yaml.

Usage:
  python3 data/scan_traps.py --from 2024-08 --to 2026-07
  python3 data/scan_traps.py --from 2024-08 --to 2026-07 --json scan.json

--from/--to bound the replay window. Earlier months in the database are
used as history (for year-over-year comparisons), never scanned as traps.

Standard library only.
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def t_of(ym):
    y, m = map(int, ym.split("-"))
    return y * 12 + m - 1


def ym_of(t):
    return f"{t // 12:04d}-{t % 12 + 1:02d}"


def pct(a, b):
    return None if not b else round(100.0 * a / b, 2)


class Scan:
    def __init__(self, con, t_from, t_to):
        self.con = con
        self.t_from, self.t_to = t_from, t_to
        self.q = lambda sql, *a: con.execute(sql, a).fetchall()
        # Passengers per carrier and month, the base of several checks.
        con.execute(
            "CREATE TEMP TABLE cm AS SELECT carrier_code, MAX(carrier_name) name,"
            " year*12+month-1 t, scope, SUM(passengers) pax FROM segments"
            " GROUP BY carrier_code, t, scope")
        con.execute("CREATE INDEX temp.cm_i ON cm(carrier_code, t)")
        self.t_min, self.t_max = self.q("SELECT MIN(t), MAX(t) FROM cm")[0]

    # -- 1. Late reporting -------------------------------------------------
    def reporting_lag(self, min_pax=20000, look_back=6, quiet_months=4):
        """Carriers that reported a year earlier but are missing from one of
        the newest months, although they filed again later or filed within
        the last few months. A carrier silent for `quiet_months` or more is
        treated as a stop (check 2), not as late filing."""
        out = []
        for t in range(max(self.t_from, self.t_max - look_back + 1), self.t_max + 1):
            rows = self.q(
                "SELECT a.carrier_code, a.name, SUM(a.pax) FROM cm a"
                " WHERE a.t = ? AND a.carrier_code NOT IN"
                "   (SELECT carrier_code FROM cm WHERE t = ?)"
                " AND (SELECT MAX(t) FROM cm b WHERE b.carrier_code = a.carrier_code) > ?"
                " GROUP BY 1 HAVING SUM(a.pax) >= ? ORDER BY 3 DESC",
                t - 12, t, self.t_max - quiet_months, min_pax)
            total_prior = self.q("SELECT SUM(pax) FROM cm WHERE t = ?", t - 12)[0][0]
            intl = self.q(
                "SELECT SUM(CASE WHEN t=? THEN pax END), SUM(CASE WHEN t=? THEN pax END)"
                " FROM cm WHERE scope='international'", t, t - 12)[0]
            missing = sum(r[2] for r in rows)
            out.append({
                "month": ym_of(t),
                "carriers_missing": len(rows),
                "their_pax_same_month_last_year": missing,
                "share_of_last_year_total_pct": pct(missing, total_prior),
                "international_yoy_pct": (
                    None if not intl[1] else round(100.0 * ((intl[0] or 0) / intl[1] - 1), 1)),
                "largest": [{"carrier": r[0], "name": r[1], "pax_last_year": r[2]}
                            for r in rows[:6]],
            })
        flagged = [o for o in out if (o["share_of_last_year_total_pct"] or 0) >= 0.5]
        return {
            "check": "reporting-lag",
            "rule_ids": ["partial-period-aggregation", "uneven-aggregation-coverage"],
            "summary": (
                f"{len(flagged)} of the newest {len(out)} months are missing carriers "
                "that carried at least 0.5% of the same month's passengers a year "
                "earlier and have not otherwise stopped. Those months read as a drop "
                "that is really late filing."),
            "candidates": out,
        }

    # -- 2. Carriers that stop or start -------------------------------------
    def carrier_exits_entries(self, min_annual_pax=500000, quiet_months=4):
        exits, entries = [], []
        rows = self.q(
            "SELECT carrier_code, MAX(name), MIN(t), MAX(t) FROM cm"
            " WHERE pax > 0 GROUP BY 1")
        for code, name, first, last in rows:
            # A stop only counts once enough later months exist to rule out
            # late filing.
            if self.t_from <= last + 1 <= self.t_to and last <= self.t_max - quiet_months:
                pax = self.q("SELECT SUM(pax) FROM cm WHERE carrier_code=? AND t BETWEEN ? AND ?",
                             code, last - 11, last)[0][0] or 0
                if pax >= min_annual_pax:
                    exits.append({"carrier": code, "name": name,
                                  "last_month": ym_of(last),
                                  "pax_final_12_months": pax})
            if self.t_from <= first <= self.t_to and first > self.t_min:
                pax = self.q("SELECT SUM(pax) FROM cm WHERE carrier_code=? AND t BETWEEN ? AND ?",
                             code, first, first + 11)[0][0] or 0
                if pax >= min_annual_pax:
                    entries.append({"carrier": code, "name": name,
                                    "first_month": ym_of(first),
                                    "pax_first_12_months": pax})
        exits.sort(key=lambda r: -r["pax_final_12_months"])
        entries.sort(key=lambda r: -r["pax_first_12_months"])
        return {
            "check": "carrier-exits-entries",
            "rule_ids": ["measurement-system-drift", "uneven-aggregation-coverage"],
            "summary": (
                f"{len(exits)} carriers stop reporting and {len(entries)} start inside "
                "the window. A trend by carrier breaks at each one; after a merger the "
                "traffic continues under another code."),
            "candidates": {"exits": exits, "entries": entries},
        }

    # -- 3. Join loss against OurAirports ------------------------------------
    def join_loss(self):
        a, b = self.t_from, self.t_to
        tot = self.q(
            "SELECT COUNT(DISTINCT origin), COUNT(*), SUM(passengers) FROM segments"
            " WHERE year*12+month-1 BETWEEN ? AND ?", a, b)[0]
        rows = self.q(
            "SELECT origin, MAX(origin_city_name), COUNT(*), SUM(passengers)"
            " FROM segments WHERE year*12+month-1 BETWEEN ? AND ?"
            " AND origin NOT IN (SELECT iata_code FROM airports WHERE iata_code IS NOT NULL)"
            " GROUP BY 1 ORDER BY 4 DESC", a, b)
        lost_rows = sum(r[2] for r in rows)
        lost_pax = sum(r[3] or 0 for r in rows)
        dup = self.q(
            "SELECT COUNT(*) FROM (SELECT iata_code FROM airports WHERE iata_code"
            " IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1)")[0][0]
        return {
            "check": "join-loss",
            "rule_ids": ["join-key-mismatch-row-loss"],
            "summary": (
                f"{len(rows)} of {tot[0]} origin codes have no OurAirports IATA match. "
                f"An inner join drops {pct(lost_rows, tot[1])}% of segment rows and "
                f"{pct(lost_pax, tot[2])}% of passengers, concentrated in a few airports."),
            "candidates": {
                "unmatched_codes": len(rows), "rows_lost_pct": pct(lost_rows, tot[1]),
                "pax_lost_pct": pct(lost_pax, tot[2]),
                "airport_codes_matching_several_rows": dup,
                "largest": [{"code": r[0], "city": r[1], "rows": r[2], "pax": r[3]}
                            for r in rows[:8]],
            },
        }

    # -- 4. Growth rankings led by tiny bases --------------------------------
    def tiny_denominator_growth(self, floor=100000, top=10):
        b = self.t_to
        cur = (b - 11, b)
        prev = (b - 23, b - 12)
        self.con.execute("DROP TABLE IF EXISTS temp.g")
        self.con.execute(
            "CREATE TEMP TABLE g AS SELECT origin,"
            " SUM(CASE WHEN year*12+month-1 BETWEEN ? AND ? THEN passengers END) p0,"
            " SUM(CASE WHEN year*12+month-1 BETWEEN ? AND ? THEN passengers END) p1"
            " FROM segments WHERE service_class='F' GROUP BY 1",
            (*prev, *cur))
        sel = ("SELECT origin, p0, p1, ROUND(100.0*(p1-p0)/p0, 1) FROM g"
               " WHERE p0 > 0 AND p1 IS NOT NULL {} ORDER BY 4 DESC LIMIT ?")
        raw = self.q(sel.format(""), top)
        floored = self.q(sel.format(f"AND p0 >= {int(floor)}"), top)
        small = sum(1 for r in raw if r[1] < floor)
        fmt = lambda rows: [{"origin": r[0], "pax_prior_12m": r[1],  # noqa: E731
                             "pax_latest_12m": r[2], "growth_pct": r[3]} for r in rows]
        return {
            "check": "tiny-denominator-growth",
            "rule_ids": ["small-sample-extremes", "divide-by-tiny-denominator"],
            "summary": (
                f"{small} of the top {len(raw)} airports by percent growth had fewer than "
                f"{floor:,} passengers in the prior 12 months. The top growth figure is "
                f"{raw[0][3]}% unfiltered and {floored[0][3]}% with that floor."
                if raw and floored else "Not enough months for a year-over-year ranking."),
            "candidates": {"window": {"prior": [ym_of(x) for x in prev],
                                      "latest": [ym_of(x) for x in cur]},
                           "unfiltered": fmt(raw), "with_floor": fmt(floored)},
        }

    # -- 5. Load factor: average of rates vs ratio of totals -----------------
    def unweighted_load_factor(self, min_pax=5e6):
        a, b = self.t_to - 11, self.t_to
        where = ("year*12+month-1 BETWEEN ? AND ? AND scope='domestic'"
                 " AND service_class='F' AND seats > 0")
        overall = self.q(
            f"SELECT ROUND(100.0*SUM(passengers)/SUM(seats),1),"
            f" ROUND(100*AVG(1.0*passengers/seats),1) FROM segments WHERE {where}", a, b)[0]
        rows = self.q(
            f"SELECT carrier_code, MAX(carrier_name),"
            f" ROUND(100.0*SUM(passengers)/SUM(seats),1) w,"
            f" ROUND(100*AVG(1.0*passengers/seats),1) u FROM segments WHERE {where}"
            f" GROUP BY 1 HAVING SUM(passengers) >= ? ORDER BY w-u DESC", a, b, min_pax)
        by_w = [r[0] for r in sorted(rows, key=lambda r: -r[2])]
        by_u = [r[0] for r in sorted(rows, key=lambda r: -r[3])]
        moved = sum(1 for c in by_w if by_w.index(c) != by_u.index(c))
        return {
            "check": "unweighted-load-factor",
            "rule_ids": ["unweighted-rate-average"],
            "summary": (
                f"Domestic scheduled load factor is {overall[0]}% as passengers over seats "
                f"but {overall[1]}% as a plain average of row-level rates. {moved} of "
                f"{len(rows)} large carriers change rank between the two methods."),
            "candidates": {
                "window": [ym_of(a), ym_of(b)],
                "overall": {"weighted_pct": overall[0], "unweighted_pct": overall[1]},
                "carriers": [{"carrier": r[0], "name": r[1], "weighted_pct": r[2],
                              "unweighted_pct": r[3]} for r in rows[:8]],
            },
        }

    # -- 6. Boardings, not travellers: segment vs market ---------------------
    def segment_vs_market(self, min_pax=5e6):
        a, b = self.t_to - 11, self.t_to
        where = "year*12+month-1 BETWEEN ? AND ? AND scope='domestic' AND service_class='F'"
        tot = self.q(
            f"SELECT (SELECT SUM(passengers) FROM segments WHERE {where}),"
            f" (SELECT SUM(passengers) FROM markets WHERE {where})", a, b, a, b)[0]
        rows = self.q(
            f"SELECT s.c, s.n, s.p, m.p, ROUND(1.0*s.p/m.p, 4) FROM"
            f" (SELECT carrier_code c, MAX(carrier_name) n, SUM(passengers) p FROM segments"
            f"  WHERE {where} GROUP BY 1) s JOIN"
            f" (SELECT carrier_code c, SUM(passengers) p FROM markets WHERE {where}"
            f"  GROUP BY 1) m ON s.c = m.c WHERE m.p >= ? ORDER BY 5 DESC", a, b, a, b, min_pax)
        return {
            "check": "segment-vs-market",
            "rule_ids": ["data-reality-gap"],
            "summary": (
                f"Segment passengers exceed market passengers by "
                f"{round(100.0 * (tot[0] / tot[1] - 1), 2)}% overall. The two tables nearly "
                "agree because both count boardings per flight; neither counts travellers "
                "or trips, so a connecting passenger appears once per flight in both."),
            "candidates": {
                "window": [ym_of(a), ym_of(b)],
                "segment_pax": tot[0], "market_pax": tot[1],
                "carriers": [{"carrier": r[0], "name": r[1], "segment_pax": r[2],
                              "market_pax": r[3], "ratio": r[4]} for r in rows[:8]],
            },
        }

    # -- 7. One city, several airports ---------------------------------------
    def multi_airport_markets(self, top=8, min_share=1.0):
        a, b = self.t_to - 11, self.t_to
        rows = self.q(
            "SELECT origin_city_market_id, origin, MAX(origin_city_name), SUM(passengers) p"
            " FROM segments WHERE year*12+month-1 BETWEEN ? AND ? AND scope='domestic'"
            " AND passengers > 0 GROUP BY 1, 2", a, b)
        markets = {}
        for mid, code, city, pax in rows:
            markets.setdefault(mid, []).append((code, city, pax))
        out = []
        for mid, airports in markets.items():
            total = sum(p for _c, _n, p in airports)
            airports.sort(key=lambda r: -r[2])
            real = [x for x in airports if 100.0 * x[2] / total >= min_share]
            if len(real) > 1:
                out.append({
                    "city_market_id": mid, "largest_airport": airports[0][0],
                    "pax": total,
                    "largest_airport_share_pct": pct(airports[0][2], total),
                    "airports": [{"code": c, "city": n, "share_pct": pct(p, total)}
                                 for c, n, p in real],
                })
        out.sort(key=lambda r: -r["pax"])
        return {
            "check": "multi-airport-city-markets",
            "rule_ids": ["measurement-system-drift", "data-reality-gap"],
            "summary": (
                f"{len(out)} BTS city markets have two or more airports each carrying at "
                f"least {min_share}% of the market. Whether a city means one airport or the "
                "market changes its totals and rank; a definition that moves between the "
                "two mid-series breaks the trend."),
            "candidates": out[:top],
        }

    # -- 8. Scheduled vs non-scheduled service --------------------------------
    def service_class_mix(self, min_pax=200000, top=8):
        a, b = self.t_to - 11, self.t_to
        where = "year*12+month-1 BETWEEN ? AND ?"
        tot = self.q(
            f"SELECT SUM(passengers), SUM(CASE WHEN service_class<>'F' THEN passengers END),"
            f" COUNT(*), SUM(CASE WHEN service_class<>'F' THEN 1 END),"
            f" SUM(CASE WHEN COALESCE(passengers,0)=0 THEN 1 END)"
            f" FROM segments WHERE {where}", a, b)[0]
        rows = self.q(
            f"SELECT carrier_code, MAX(carrier_name), SUM(passengers),"
            f" ROUND(100.0*SUM(CASE WHEN service_class<>'F' THEN passengers ELSE 0 END)"
            f"/SUM(passengers),1) FROM segments WHERE {where} GROUP BY 1"
            f" HAVING SUM(passengers) >= ? ORDER BY 4 DESC LIMIT ?", a, b, min_pax, top)
        return {
            "check": "service-class-mix",
            "rule_ids": ["data-reality-gap", "uneven-aggregation-coverage"],
            "summary": (
                f"Non-scheduled service is {pct(tot[1] or 0, tot[0])}% of passengers but "
                f"{pct(tot[3] or 0, tot[2])}% of rows, and {pct(tot[4] or 0, tot[2])}% of "
                "rows carry no passengers (cargo and positioning flights). Counts of "
                "flights, routes or rows mean something different from passenger totals, "
                "and for some carriers charter traffic is most of the business."),
            "candidates": [{"carrier": r[0], "name": r[1], "pax": r[2],
                            "non_scheduled_pct": r[3]} for r in rows],
        }

    # -- 9. Simpson's paradox between carriers --------------------------------
    def simpsons_load_factor(self, top_n=12):
        """Carrier pairs where A beats B on overall load factor but trails B
        in every distance band both fly."""
        a, b = self.t_to - 11, self.t_to
        rows = self.q(
            "SELECT carrier_code, MAX(carrier_name),"
            " CASE WHEN distance_miles < 500 THEN '<500' WHEN distance_miles < 1000"
            " THEN '500-999' WHEN distance_miles < 2000 THEN '1000-1999' ELSE '2000+' END,"
            " SUM(passengers), SUM(seats) FROM segments"
            " WHERE year*12+month-1 BETWEEN ? AND ? AND scope='domestic'"
            " AND service_class='F' AND seats > 0 GROUP BY 1, 3", a, b)
        car, names = {}, {}
        for code, name, band, pax, seats in rows:
            car.setdefault(code, {})[band] = (pax, seats)
            names[code] = name
        big = sorted(car, key=lambda c: -sum(p for p, _s in car[c].values()))[:top_n]
        lf = lambda p, s: 100.0 * p / s  # noqa: E731
        found = []
        for x in big:
            for y in big:
                if x == y:
                    continue
                ox = lf(*map(sum, zip(*car[x].values())))
                oy = lf(*map(sum, zip(*car[y].values())))
                # Only bands where both carriers have real capacity.
                shared = [k for k in car[x] if k in car[y]
                          and min(car[x][k][1], car[y][k][1]) >= 500000]
                if ox > oy and len(shared) >= 3 and all(
                        lf(*car[x][k]) < lf(*car[y][k]) for k in shared):
                    found.append({
                        "higher_overall": x, "higher_overall_name": names[x],
                        "lower_overall": y, "lower_overall_name": names[y],
                        "overall_pct": [round(ox, 1), round(oy, 1)],
                        "by_distance_band_pct": {
                            k: [round(lf(*car[x][k]), 1), round(lf(*car[y][k]), 1)]
                            for k in sorted(shared)},
                    })
        return {
            "check": "simpsons-load-factor",
            "rule_ids": ["simpsons-paradox"],
            "summary": (
                f"{len(found)} pairs among the {top_n} largest domestic carriers reverse: one "
                "has the higher overall load factor yet the lower one in every distance "
                "band both fly." if found else
                f"No full reversal by distance band among the {top_n} largest domestic "
                "carriers in this window."),
            "candidates": found,
        }

    def run(self):
        return [
            self.reporting_lag(), self.carrier_exits_entries(), self.join_loss(),
            self.tiny_denominator_growth(), self.unweighted_load_factor(),
            self.segment_vs_market(), self.multi_airport_markets(),
            self.service_class_mix(), self.simpsons_load_factor(),
        ]


def scan(db_path, month_from, month_to):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    lo, hi = con.execute(
        "SELECT MIN(year*12+month-1), MAX(year*12+month-1) FROM segments").fetchone()
    if lo is None:
        raise SystemExit("The database has no segment rows.")
    t_from, t_to = t_of(month_from), t_of(month_to)
    if not (lo <= t_from <= t_to <= hi):
        raise SystemExit(
            f"Window {month_from}..{month_to} is outside the data ({ym_of(lo)}..{ym_of(hi)}).")
    results = Scan(con, t_from, t_to).run()
    files = con.execute(
        "SELECT COUNT(*), MIN(fetched_at), MAX(fetched_at) FROM source_files").fetchone()
    con.close()
    return {
        "window": {"from": month_from, "to": month_to},
        "data": {"from": ym_of(lo), "to": ym_of(hi), "source_files": files[0],
                 "fetched_from": files[1], "fetched_to": files[2]},
        "checks": results,
    }


def main():
    ap = argparse.ArgumentParser(description="Propose data traps from the bench database.")
    ap.add_argument("--db", default=os.path.join(HERE, "bench.db"))
    ap.add_argument("--from", dest="month_from", required=True, help="first replay month, YYYY-MM")
    ap.add_argument("--to", dest="month_to", required=True, help="last replay month, YYYY-MM")
    ap.add_argument("--json", help="also write the full report to this file")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        raise SystemExit(f"No database at {args.db}. Build it with data/build_database.py.")
    report = scan(args.db, args.month_from, args.month_to)
    d = report["data"]
    print(f"Window {args.month_from}..{args.month_to} "
          f"(data {d['from']}..{d['to']}, fetched {d['fetched_to']})\n")
    for c in report["checks"]:
        print(f"[{c['check']}]  rules: {', '.join(c['rule_ids'])}")
        print(f"  {c['summary']}\n")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
        print(f"Full report -> {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
