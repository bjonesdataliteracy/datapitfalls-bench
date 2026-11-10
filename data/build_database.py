"""
datapitfalls bench: database builder
====================================
Builds the benchmark's SQLite database from real, public-domain air travel
data. Nothing is edited, filtered or aggregated: every row BTS and
OurAirports publish for the requested months is loaded as is.

  BTS T-100 Segment (Domestic + International)   traffic per nonstop leg
  BTS T-100 Market  (Domestic + International)   traffic per on-flight market
  OurAirports airports.csv + countries.csv        global dimensions
  BTS lookup tables                               carriers, aircraft, classes

Usage:
  python3 data/build_database.py --months 24 --end-month 2026-07
  python3 data/build_database.py --from-raw        # rebuild from data/raw only
  python3 data/build_database.py --fixtures data/tests/fixtures --db /tmp/t.db

Notes:
  - BTS has no REST API. Acquisition is a scripted POST to the TranStats
    download form, one request per table, scope and month, run one at a
    time and cached under data/raw/. A cached file is never re-downloaded,
    so data/raw/ is also the as-released snapshot of what BTS served on
    the day it was fetched. The fetch time and a hash of every file are
    recorded in the source_files table.
  - Every file's header is checked against expected_fields.json before a
    row loads, so silent column drift fails the build.
  - Standard library only.

Adapted from the SQLiteracy teaching-database pipeline by Data Literacy.
"""
import argparse
import csv
import hashlib
import io
import json
import os
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OURAIRPORTS_BASE = ("https://raw.githubusercontent.com/davidmegginson/"
                    "ourairports-data/main")
# TranStats download form (ASP.NET postback). Table codes are the gnoyr_VQ
# parameter on the Air Carrier Statistics (All Carriers) tables page.
TRANSTATS_FORM = "https://www.transtats.bts.gov/DL_SelectFields.aspx"
T100_TABLES = {
    ("segment", "domestic"): "GEE",
    ("segment", "international"): "FJE",
    ("market", "domestic"): "GED",
    ("market", "international"): "FJD",
}
SCOPES = ("domestic", "international")
# Lookup tables: (raw filename, Download_Lookup code).
LOOKUPS = {
    "carriers": ("L_UNIQUE_CARRIERS", "Y_haVdhR_PNeeVRef"),
    "aircraft_types": ("L_AIRCRAFT_TYPE", "Y_NVePeNSg_glcR"),
    "service_classes": ("L_SERVICE_CLASS", "Y_fReiVPR_PYNff"),
}
LOOKUP_URL = "https://www.transtats.bts.gov/Download_Lookup.asp?Y11x72="

# Shared by both tables: who flew, between where, when.
COMMON = [
    ("year", "YEAR", int), ("month", "MONTH", int),
    ("carrier_code", "UNIQUE_CARRIER", str),
    ("carrier_name", "UNIQUE_CARRIER_NAME", str),
    ("carrier_entity", "UNIQUE_CARRIER_ENTITY", str),
    ("airline_id", "AIRLINE_ID", int),
    ("carrier_region", "REGION", str),
    ("carrier_group", "CARRIER_GROUP_NEW", int),
    ("origin", "ORIGIN", str),
    ("origin_airport_id", "ORIGIN_AIRPORT_ID", int),
    ("origin_city_market_id", "ORIGIN_CITY_MARKET_ID", int),
    ("origin_city_name", "ORIGIN_CITY_NAME", str),
    ("origin_state", "ORIGIN_STATE_ABR", str),      # domestic files only
    ("origin_country", "ORIGIN_COUNTRY", str),      # international files only
    ("dest", "DEST", str),
    ("dest_airport_id", "DEST_AIRPORT_ID", int),
    ("dest_city_market_id", "DEST_CITY_MARKET_ID", int),
    ("dest_city_name", "DEST_CITY_NAME", str),
    ("dest_state", "DEST_STATE_ABR", str),          # domestic files only
    ("dest_country", "DEST_COUNTRY", str),          # international files only
    ("service_class", "CLASS", str),
    ("distance_miles", "DISTANCE", int),
    ("passengers", "PASSENGERS", int),
    ("freight_lbs", "FREIGHT", int),
    ("mail_lbs", "MAIL", int),
]
COLUMNS = {
    "segment": COMMON + [
        ("aircraft_type_id", "AIRCRAFT_TYPE", int),
        ("aircraft_config", "AIRCRAFT_CONFIG", int),
        ("departures_scheduled", "DEPARTURES_SCHEDULED", int),
        ("departures_performed", "DEPARTURES_PERFORMED", int),
        ("seats", "SEATS", int),
        ("payload_lbs", "PAYLOAD", int),
        ("ramp_minutes", "RAMP_TO_RAMP", int),
        ("air_minutes", "AIR_TIME", int),
    ],
    "market": COMMON,
}
TABLE_NAME = {"segment": "segments", "market": "markets"}
# BTS publishes state columns only in domestic files and country columns
# only in international ones; the other pair loads as NULL.
SCOPE_ONLY = {
    "ORIGIN_STATE_ABR": "domestic", "DEST_STATE_ABR": "domestic",
    "ORIGIN_COUNTRY": "international", "DEST_COUNTRY": "international",
}


def source_fields(kind, scope):
    """BTS field names this builder reads from one table and scope."""
    return [src for _n, src, _t in COLUMNS[kind]
            if SCOPE_ONLY.get(src, scope) == scope]


def _fact_ddl(kind):
    cols = ",\n    ".join(
        f"{name} {'INTEGER' if typ is int else 'TEXT'}"
        for name, _src, typ in COLUMNS[kind])
    t = TABLE_NAME[kind]
    return f"""
CREATE TABLE IF NOT EXISTS {t} (
    {kind}_id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,   -- 'domestic' | 'international'
    {cols}
);
CREATE INDEX IF NOT EXISTS idx_{t}_time    ON {t}(year, month);
CREATE INDEX IF NOT EXISTS idx_{t}_route   ON {t}(origin, dest);
CREATE INDEX IF NOT EXISTS idx_{t}_carrier ON {t}(carrier_code);
"""


SCHEMA = """
CREATE TABLE IF NOT EXISTS countries (
    iso_code TEXT PRIMARY KEY, name TEXT NOT NULL, continent TEXT
);
CREATE TABLE IF NOT EXISTS airports (
    airport_id INTEGER PRIMARY KEY,   -- OurAirports id
    ident TEXT NOT NULL, iata_code TEXT, name TEXT NOT NULL,
    type TEXT,                        -- includes 'closed'; nothing is dropped
    municipality TEXT, iso_country TEXT, iso_region TEXT,
    latitude REAL, longitude REAL, elevation_ft INTEGER,
    scheduled_service TEXT
);
CREATE TABLE IF NOT EXISTS carriers (
    carrier_code TEXT PRIMARY KEY, carrier_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aircraft_types (
    aircraft_type_id INTEGER PRIMARY KEY, aircraft_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_classes (
    class_code TEXT PRIMARY KEY, description TEXT NOT NULL
);
-- One row per input file: what was loaded, and when it was fetched.
CREATE TABLE IF NOT EXISTS source_files (
    file TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT,
    year INTEGER, month INTEGER, rows INTEGER NOT NULL,
    sha256 TEXT NOT NULL, fetched_at TEXT NOT NULL
);
""" + _fact_ddl("segment") + _fact_ddl("market")


def expected_headers():
    with open(os.path.join(HERE, "expected_fields.json"), encoding="utf-8") as f:
        return json.load(f)


def verify_header(kind, fieldnames, source):
    """Fail loudly if a required column is missing from an input file."""
    required = expected_headers()[kind]
    got = set(fieldnames or [])
    missing = [c for c in required if c not in got]
    if missing:
        raise SystemExit(f"SCHEMA DRIFT in {source}: missing columns {missing}")


def http_get(url, timeout=180, retries=4):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            if attempt < retries - 1:
                wait = 2 * 2 ** attempt
                print(f"    retry {attempt + 1}/{retries - 1} in {wait}s "
                      f"({type(e).__name__})", flush=True)
                time.sleep(wait)
    raise last


def bts_month_csv(kind, scope, year, month, timeout=600, retries=3):
    """Download one month of one T-100 table for one scope. Returns CSV text.

    GET the select-fields page, harvest the VIEWSTATE family, then POST
    every field checkbox plus year and month. The response is a zip with
    the data CSV. HTML error pages arrive with HTTP 200, so non-zip
    responses are rejected and retried. A month BTS has not published yet
    returns a header-only CSV."""
    from http.cookiejar import CookieJar
    wanted = source_fields(kind, scope)
    url = TRANSTATS_FORM + "?" + urllib.parse.urlencode(
        {"gnoyr_VQ": T100_TABLES[(kind, scope)],
         "QO_fu146_anzr": "Nv4 Pn44vr45"})
    ua = {"User-Agent": "Mozilla/5.0"}
    last = None
    for attempt in range(retries):
        try:
            opener = urllib.request.build_opener(
                urllib.request.HTTPCookieProcessor(CookieJar()))
            page = opener.open(urllib.request.Request(url, headers=ua),
                               timeout=120).read().decode("utf-8", "replace")

            def hidden(name):
                m = re.search(rf'name="{name}"[^>]*value="([^"]*)"', page)
                return m.group(1) if m else ""

            form = {n: hidden(n) for n in
                    ("__EVENTTARGET", "__EVENTARGUMENT", "__LASTFOCUS",
                     "__VIEWSTATE", "__VIEWSTATEGENERATOR",
                     "__EVENTVALIDATION")}
            if not form["__VIEWSTATE"]:
                raise ValueError("TranStats form page missing __VIEWSTATE; "
                                 "access mechanics may have changed")
            missing = [f for f in wanted
                       if not re.search(rf'name="{f}"', page)]
            if missing:
                raise ValueError(f"TranStats form missing field checkboxes "
                                 f"{missing}; table layout drifted")
            form.update({"cboGeography": "All", "cboYear": str(year),
                         "cboPeriod": str(month), "chkDownloadZip": "on",
                         "btnDownload": "Download"})
            for f in wanted:
                form[f] = "on"
            req = urllib.request.Request(
                url, data=urllib.parse.urlencode(form).encode(),
                headers={**ua, "Referer": url,
                         "Content-Type": "application/x-www-form-urlencoded"})
            blob = opener.open(req, timeout=timeout).read()
            if blob[:2] != b"PK":
                text = blob[:200_000].decode("utf-8", "replace")
                if re.search(r"No data available for", text):
                    return ",".join(wanted) + "\n"
                raise ValueError("TranStats returned non-zip content (likely "
                                 "an HTML error page)")
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                names = [n for n in z.namelist()
                         if n.lower().endswith(".csv")
                         and "documentation" not in n.lower()]
                if not names:
                    raise ValueError("TranStats zip contained no data CSV")
                return z.read(names[0]).decode("utf-8-sig")
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            if attempt < retries - 1:
                wait = 5 * 2 ** attempt
                print(f"    retry {attempt + 1}/{retries - 1} in {wait}s "
                      f"({type(e).__name__}: {e})", flush=True)
                time.sleep(wait)
    raise last


def conv(value, typ):
    if value in ("", None):
        return None
    return int(float(value)) if typ is int else value


class Db:
    def __init__(self, path):
        self.con = sqlite3.connect(path)
        self.con.executescript(SCHEMA)

    def record(self, path, kind, rows, scope=None, year=None, month=None):
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        fetched = datetime.fromtimestamp(
            os.path.getmtime(path), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.con.execute(
            "INSERT OR REPLACE INTO source_files VALUES (?,?,?,?,?,?,?,?)",
            (os.path.basename(path), kind, scope, year, month, rows, digest,
             fetched))

    def load_countries(self, path):
        reader = file_reader(path)
        verify_header("ourairports_countries", reader.fieldnames, path)
        rows = [(r["code"], r["name"], r["continent"]) for r in reader]
        self.con.executemany(
            "INSERT OR REPLACE INTO countries VALUES (?,?,?)", rows)
        self.record(path, "countries", len(rows))

    def load_airports(self, path):
        reader = file_reader(path)
        verify_header("ourairports_airports", reader.fieldnames, path)
        rows = [(r["id"], r["ident"], r["iata_code"] or None, r["name"],
                 r["type"], r["municipality"] or None, r["iso_country"],
                 r["iso_region"], r["latitude_deg"] or None,
                 r["longitude_deg"] or None, r["elevation_ft"] or None,
                 r["scheduled_service"]) for r in reader]
        self.con.executemany(
            "INSERT OR REPLACE INTO airports VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            rows)
        self.record(path, "airports", len(rows))

    def load_lookup(self, table, path):
        reader = file_reader(path)
        verify_header("bts_lookup", reader.fieldnames, path)
        rows = [(r["Code"], r["Description"]) for r in reader]
        if table == "aircraft_types":
            rows = [(conv(c, int), d) for c, d in rows]
        self.con.executemany(
            f"INSERT OR REPLACE INTO {table} VALUES (?,?)", rows)
        self.record(path, table, len(rows))

    def load_t100(self, kind, scope, year, month, path):
        reader = file_reader(path)
        got = set(reader.fieldnames or [])
        missing = [f for f in source_fields(kind, scope) if f not in got]
        if missing:
            raise SystemExit(f"SCHEMA DRIFT in {path}: missing columns {missing}")
        cols = COLUMNS[kind]
        sql = (f"INSERT INTO {TABLE_NAME[kind]} (scope, "
               + ", ".join(n for n, _s, _t in cols) + ") VALUES ("
               + ",".join("?" * (len(cols) + 1)) + ")")
        rows = [(scope, *[conv(r.get(src), typ) for _n, src, typ in cols])
                for r in reader]
        self.con.executemany(sql, rows)
        self.record(path, f"t100_{kind}", len(rows), scope, year, month)
        return len(rows)

    def done(self):
        self.con.commit()
        for t in ("countries", "airports", "carriers", "aircraft_types",
                  "service_classes", "segments", "markets", "source_files"):
            n = self.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"  {t:16s} {n:>10,} rows")
        self.con.close()


def file_reader(path):
    return csv.DictReader(open(path, encoding="utf-8-sig", newline=""))


def month_windows(n, end):
    """Trailing n (year, month) pairs ending at `end` ('YYYY-MM'), oldest first."""
    y, m = map(int, end.split("-"))
    out = []
    for _ in range(n):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


def raw_name(kind, scope, y, m):
    return f"t100_{kind}_{scope}_{y}_{m:02d}.csv"


def load_dimensions(db, raw_dir, offline):
    def ensure(path, url, label):
        if os.path.exists(path):
            return True
        if offline:
            print(f"  {label}: not in raw dir, skipping", flush=True)
            return False
        print(f"Fetching {label} ...", flush=True)
        data = http_get(url)
        with open(path, "wb") as f:
            f.write(data)
        return True

    for name, loader in (("countries", db.load_countries),
                         ("airports", db.load_airports)):
        path = os.path.join(raw_dir, f"{name}.csv")
        if ensure(path, f"{OURAIRPORTS_BASE}/{name}.csv", f"OurAirports {name}"):
            loader(path)
    for table, (lookup, code) in LOOKUPS.items():
        path = os.path.join(raw_dir, f"{lookup}.csv")
        if ensure(path, LOOKUP_URL + code, f"BTS lookup {lookup}"):
            db.load_lookup(table, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[2])
    ap.add_argument("--db", default=os.path.join(HERE, "bench.db"))
    ap.add_argument("--months", type=int, help="number of months to load")
    ap.add_argument("--end-month", help="newest month to load, YYYY-MM")
    ap.add_argument("--raw-dir", default=os.path.join(HERE, "raw"),
                    help="cache of downloaded inputs (the as-released snapshot)")
    ap.add_argument("--from-raw", action="store_true",
                    help="load every T-100 file already in --raw-dir; no network")
    ap.add_argument("--fixtures", help="test mode: use this directory as "
                    "the raw dir, with no network")
    ap.add_argument("--kinds", default="segment,market",
                    help="comma list of T-100 tables to load")
    args = ap.parse_args()

    raw_dir = args.fixtures or args.raw_dir
    offline = bool(args.fixtures or args.from_raw)
    os.makedirs(raw_dir, exist_ok=True)
    kinds = [k for k in args.kinds.split(",") if k]
    if os.path.exists(args.db):
        os.remove(args.db)   # always a clean build; inputs live in raw/
    db = Db(args.db)
    load_dimensions(db, raw_dir, offline)

    if offline:
        jobs = []
        for name in sorted(os.listdir(raw_dir)):
            m = re.fullmatch(r"t100_(segment|market)_(domestic|international)"
                             r"_(\d{4})_(\d{2})\.csv", name)
            if m and m.group(1) in kinds:
                jobs.append((m.group(1), m.group(2), int(m.group(3)),
                             int(m.group(4))))
    else:
        if not (args.months and args.end_month):
            raise SystemExit("--months and --end-month are required "
                             "(or use --from-raw)")
        jobs = [(k, s, y, m) for y, m in month_windows(args.months, args.end_month)
                for k in kinds for s in SCOPES]

    for kind, scope, y, m in jobs:
        path = os.path.join(raw_dir, raw_name(kind, scope, y, m))
        if not os.path.exists(path):
            print(f"Downloading T-100 {kind} {scope} {y}-{m:02d} ...", flush=True)
            text = bts_month_csv(kind, scope, y, m)
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
        n = db.load_t100(kind, scope, y, m, path)
        print(f"  {y}-{m:02d} {kind:7s} {scope:13s} {n:>7,} rows", flush=True)

    db.done()
    print(f"OK -> {args.db}")


if __name__ == "__main__":
    main()
