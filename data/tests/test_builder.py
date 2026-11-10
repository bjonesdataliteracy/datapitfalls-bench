"""Network-free tests for the database builder. Run: python3 data/tests/test_builder.py"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(0, DATA)
import build_database as b  # noqa: E402


def build(raw_dir, db):
    return subprocess.run(
        [sys.executable, os.path.join(DATA, "build_database.py"),
         "--fixtures", raw_dir, "--db", db], capture_output=True, text=True)


class BuilderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.raw = os.path.join(self.tmp, "raw")
        shutil.copytree(FIXTURES, self.raw)
        self.db = os.path.join(self.tmp, "t.db")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_loads_every_row_unchanged(self):
        r = build(self.raw, self.db)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        con = sqlite3.connect(self.db)
        q = lambda sql: con.execute(sql).fetchall()  # noqa: E731
        self.assertEqual(q("SELECT COUNT(*) FROM segments"), [(2,)])
        self.assertEqual(q("SELECT COUNT(*) FROM markets"), [(2,)])
        # Closed airports are kept: the builder drops nothing.
        self.assertEqual(q("SELECT COUNT(*) FROM airports WHERE type='closed'"), [(1,)])
        # Decimal strings become integers; blanks become NULL.
        self.assertEqual(
            q("SELECT passengers, seats, mail_lbs FROM segments WHERE scope='domestic'"),
            [(150, 180, None)])
        # State columns exist only in domestic files, country only in international.
        self.assertEqual(
            q("SELECT scope, origin_state, origin_country FROM markets ORDER BY scope"),
            [("domestic", "WA", None), ("international", None, "US")])
        con.close()

    def test_records_each_input_file(self):
        build(self.raw, self.db)
        con = sqlite3.connect(self.db)
        rows = con.execute(
            "SELECT kind, scope, year, month, rows, length(sha256) FROM source_files "
            "WHERE kind LIKE 't100_%' ORDER BY kind, scope").fetchall()
        self.assertEqual(rows, [
            ("t100_market", "domestic", 2099, 1, 1, 64),
            ("t100_market", "international", 2099, 1, 1, 64),
            ("t100_segment", "domestic", 2099, 1, 1, 64),
            ("t100_segment", "international", 2099, 1, 1, 64)])
        self.assertEqual(con.execute("SELECT COUNT(*) FROM source_files").fetchone(), (9,))
        con.close()

    def test_missing_column_fails_the_build(self):
        path = os.path.join(self.raw, b.raw_name("segment", "domestic", 2099, 1))
        text = open(path, encoding="utf-8").read().replace("PASSENGERS", "PAX")
        open(path, "w", encoding="utf-8").write(text)
        r = build(self.raw, self.db)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SCHEMA DRIFT", r.stdout + r.stderr)
        self.assertIn("PASSENGERS", r.stdout + r.stderr)

    def test_month_windows(self):
        self.assertEqual(b.month_windows(3, "2026-01"),
                         [(2025, 11), (2025, 12), (2026, 1)])

    def test_scope_specific_fields(self):
        dom = b.source_fields("market", "domestic")
        intl = b.source_fields("market", "international")
        self.assertIn("ORIGIN_STATE_ABR", dom)
        self.assertNotIn("ORIGIN_COUNTRY", dom)
        self.assertIn("ORIGIN_COUNTRY", intl)
        self.assertNotIn("ORIGIN_STATE_ABR", intl)


if __name__ == "__main__":
    unittest.main()
