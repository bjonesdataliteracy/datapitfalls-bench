"""Network-free tests for the trap scanner, on a small synthetic database.
Run: python3 data/tests/test_scan_traps.py"""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

DATA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, DATA)
import build_database as b  # noqa: E402
import scan_traps as s  # noqa: E402

FIRST, LAST = "2098-01", "2099-12"   # 24 synthetic months


def seg(con, ym, carrier, origin, dest, pax, seats, scope="domestic",
        cls="F", dist=800, name=None):
    y, m = map(int, ym.split("-"))
    con.execute(
        "INSERT INTO segments (scope, year, month, carrier_code, carrier_name, origin,"
        " origin_city_market_id, origin_city_name, dest, service_class, distance_miles,"
        " passengers, seats) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (scope, y, m, carrier, name or f"FIXTURE {carrier}", origin,
         {"AAA": 1, "BBB": 1, "CCC": 2}.get(origin, 9), f"FIXTURE {origin}", dest,
         cls, dist, pax, seats))
    con.execute(
        "INSERT INTO markets (scope, year, month, carrier_code, origin, dest,"
        " service_class, passengers) VALUES (?,?,?,?,?,?,?,?)",
        (scope, y, m, carrier, origin, dest, cls, pax))


def months():
    t = s.t_of(FIRST)
    while t <= s.t_of(LAST):
        yield s.ym_of(t)
        t += 1


class ScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "t.db")
        con = sqlite3.connect(cls.db)
        con.executescript(b.SCHEMA)
        con.executemany(
            "INSERT INTO airports (airport_id, ident, iata_code, name, type) VALUES (?,?,?,?,?)",
            [(1, "KAAA", "AAA", "FIXTURE Alpha", "large_airport"),
             (2, "KBBB", "BBB", "FIXTURE Bravo", "large_airport"),
             (3, "KCCC", "CCC", "FIXTURE Charlie", "small_airport")])
        con.execute("INSERT INTO source_files VALUES ('f.csv','t100_segment','domestic',"
                    "2099,12,1,'0','2099-12-31T00:00:00Z')")
        for ym in months():
            # Steady: files every month. One big full row and one small empty one.
            seg(con, ym, "ST", "AAA", "BBB", 900000, 1000000)
            seg(con, ym, "ST", "BBB", "AAA", 100, 1000, dist=300)
            # Second airport in the same city market as AAA.
            seg(con, ym, "ST", "BBB", "CCC", 300000, 400000)
            # Unmatched airport code: no row in airports.
            seg(con, ym, "ST", "ZZZ", "AAA", 50000, 60000)
            # Late filer: international, missing only from the newest two months.
            if ym <= "2099-10":
                seg(con, ym, "LT", "AAA", "XXX", 200000, 250000, scope="international")
            # Stopper: last files in 2099-03, nine months before the data ends.
            if ym <= "2099-03":
                seg(con, ym, "EX", "AAA", "BBB", 100000, 120000)
            # Tiny airport that grows 100x in the latest year.
            seg(con, ym, "ST", "CCC", "AAA", 1 if ym < "2099-01" else 100, 200)
        con.commit()
        con.close()
        cls.report = s.scan(cls.db, "2098-07", LAST)
        cls.by = {c["check"]: c for c in cls.report["checks"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_late_filer_is_lag_not_exit(self):
        lag = {o["month"]: o for o in self.by["reporting-lag"]["candidates"]}
        self.assertEqual([x["carrier"] for x in lag["2099-12"]["largest"]], ["LT"])
        self.assertEqual([x["carrier"] for x in lag["2099-11"]["largest"]], ["LT"])
        self.assertEqual(lag["2099-10"]["carriers_missing"], 0)
        exits = self.by["carrier-exits-entries"]["candidates"]["exits"]
        self.assertNotIn("LT", [e["carrier"] for e in exits])

    def test_stopper_is_exit_not_lag(self):
        exits = self.by["carrier-exits-entries"]["candidates"]["exits"]
        self.assertEqual([(e["carrier"], e["last_month"]) for e in exits],
                         [("EX", "2099-03")])
        for o in self.by["reporting-lag"]["candidates"]:
            self.assertNotIn("EX", [x["carrier"] for x in o["largest"]])

    def test_join_loss_finds_the_unmatched_code(self):
        c = self.by["join-loss"]["candidates"]
        self.assertEqual([x["code"] for x in c["largest"]], ["ZZZ"])
        self.assertEqual(c["unmatched_codes"], 1)
        self.assertGreater(c["pax_lost_pct"], 0)

    def test_tiny_base_tops_growth_until_floored(self):
        c = self.by["tiny-denominator-growth"]["candidates"]
        self.assertEqual(c["unfiltered"][0]["origin"], "CCC")
        self.assertEqual(c["unfiltered"][0]["growth_pct"], 9900.0)
        self.assertNotIn("CCC", [x["origin"] for x in c["with_floor"]])

    def test_average_of_rates_differs_from_ratio_of_totals(self):
        o = self.by["unweighted-load-factor"]["candidates"]["overall"]
        self.assertGreater(o["weighted_pct"], o["unweighted_pct"] + 10)

    def test_multi_airport_market(self):
        m = self.by["multi-airport-city-markets"]["candidates"]
        self.assertEqual(len(m), 1)
        self.assertEqual({a["code"] for a in m[0]["airports"]}, {"AAA", "BBB"})

    def test_every_check_cites_rule_ids_and_a_summary(self):
        self.assertEqual(len(self.report["checks"]), 9)
        for c in self.report["checks"]:
            self.assertTrue(c["rule_ids"], c["check"])
            self.assertTrue(c["summary"], c["check"])

    def test_window_outside_the_data_is_refused(self):
        with self.assertRaises(SystemExit):
            s.scan(self.db, "2097-01", LAST)

    def test_scanner_opens_the_database_read_only(self):
        before = os.path.getmtime(self.db), os.path.getsize(self.db)
        s.scan(self.db, "2098-07", LAST)
        self.assertEqual(before, (os.path.getmtime(self.db), os.path.getsize(self.db)))


if __name__ == "__main__":
    unittest.main()
