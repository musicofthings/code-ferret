#!/usr/bin/env python3
"""Build a >15-file repo with a clean baseline, then a change commit that plants
known bugs across all five detection vectors. Ground truth is returned so a
fan-out review can be scored for recall and precision per vector.
"""
import json
import pathlib
import shutil
import subprocess
import sys

DEST = pathlib.Path(sys.argv[1])
if DEST.exists():
    shutil.rmtree(DEST)
(DEST / "src").mkdir(parents=True)


def git(*a):
    subprocess.run(["git", "-C", str(DEST), *a], check=True,
                   capture_output=True, text=True)


# (filename, clean version, buggy version, vector, what breaks)
CASES = [
    ("auth.py", """
import sqlite3

def lookup(conn, token):
    cur = conn.cursor()
    cur.execute("SELECT uid FROM sessions WHERE token = ?", (token,))
    return cur.fetchone()
""", """
import sqlite3

def lookup(conn, token):
    cur = conn.cursor()
    cur.execute("SELECT uid FROM sessions WHERE token = '%s'" % token)
    return cur.fetchone()
""", "SECURITY", "SQL injection via %-format interpolation of token"),

    ("render.py", """
import html

def profile_html(name):
    return "<div>" + html.escape(name) + "</div>"
""", """
def profile_html(name):
    return "<div>" + name + "</div>"
""", "SECURITY", "XSS: html.escape removed from user-controlled name"),

    ("loader.py", """
import json

def load_config(blob):
    return json.loads(blob)
""", """
import pickle

def load_config(blob):
    return pickle.loads(blob)
""", "SECURITY", "unsafe deserialization: pickle.loads on untrusted input"),

    ("paging.py", """
def page(items, size, n):
    start = n * size
    return items[start:start + size]
""", """
def page(items, size, n):
    start = n * size
    return [items[i] for i in range(start, start + size + 1)]
""", "LOGIC", "off-by-one: indexes one past the slice, IndexError on last page"),

    ("parse.py", """
def first_field(line):
    parts = line.split(",")
    if not parts:
        return None
    return parts[0]
""", """
def first_field(line):
    parts = line.split(",")
    return parts[1]
""", "LOGIC", "unguarded index: parts[1] raises IndexError on a single-field line"),

    ("retry.py", """
def retry(fn, attempts=3):
    for i in range(attempts):
        try:
            return fn()
        except Exception:
            if i == attempts - 1:
                raise
    return None
""", """
def retry(fn, attempts=3):
    while True:
        try:
            return fn()
        except Exception:
            continue
""", "LOGIC", "infinite loop: retry never terminates on a persistently failing fn"),

    ("counter.py", """
import threading

_lock = threading.Lock()
_hits = {}

def bump(key):
    with _lock:
        _hits[key] = _hits.get(key, 0) + 1
        return _hits[key]
""", """
import threading

_lock = threading.Lock()
_hits = {}

def bump(key):
    _hits[key] = _hits.get(key, 0) + 1
    return _hits[key]
""", "CONCURRENCY", "unsynchronized read-modify-write on shared dict loses counts"),

    ("cache_init.py", """
import threading

_lock = threading.Lock()
_cache = None

def get_cache():
    global _cache
    with _lock:
        if _cache is None:
            _cache = {"built": True}
        return _cache
""", """
_cache = None

def get_cache():
    global _cache
    if _cache is None:
        _cache = {"built": True}
    return _cache
""", "CONCURRENCY", "double-checked init without a lock: concurrent callers build twice"),

    ("lookup.py", """
def enrich(rows, users):
    index = {u["id"]: u for u in users}
    return [dict(r, user=index.get(r["uid"])) for r in rows]
""", """
def enrich(rows, users):
    return [dict(r, user=next((u for u in users if u["id"] == r["uid"]), None))
            for r in rows]
""", "PERFORMANCE", "O(N*M): dict index replaced with a linear scan per row"),

    ("report_perf.py", """
def totals(records):
    acc = {}
    for r in records:
        acc[r["k"]] = acc.get(r["k"], 0) + r["v"]
    return acc
""", """
def totals(records):
    acc = {}
    for r in records:
        keys = [x["k"] for x in records]
        if r["k"] in keys:
            acc[r["k"]] = acc.get(r["k"], 0) + r["v"]
    return acc
""", "PERFORMANCE", "O(N^2): rebuilds the full key list inside the loop"),

    ("api_client.py", """
def fetch(session, url, timeout=10):
    return session.get(url, timeout=timeout)
""", """
def fetch(session, url):
    return session.get(url)
""", "API", "removed timeout: a hung server blocks the caller forever"),

    ("public_api.py", """
def create_user(name, email, role="member"):
    return {"name": name, "email": email, "role": role}
""", """
def create_user(name, email, role, tenant):
    return {"name": name, "email": email, "role": role, "tenant": tenant}
""", "API", "breaking change: optional param became required, plus a new required arg"),
]

# Clean filler so the diff exceeds the fan-out threshold and agents must
# distinguish signal from noise.
FILLER = 10

BASE = {}
for fname, clean, _, _, _ in CASES:
    BASE[f"src/{fname}"] = clean.lstrip()
for i in range(FILLER):
    BASE[f"src/util{i}.py"] = f"def helper{i}(x):\n    return x * {i + 1}\n"

for path, content in BASE.items():
    (DEST / path).write_text(content)
(DEST / "package-lock.json").write_text('{"lockfileVersion":3,"packages":{}}\n')

git("init", "-q", ".")
git("config", "user.email", "fan@example.com")
git("config", "user.name", "Fan")
git("add", "-A")
git("commit", "-qm", "baseline: correct implementations")
base_sha = subprocess.run(["git", "-C", str(DEST), "rev-parse", "HEAD"],
                          capture_output=True, text=True).stdout.strip()

truth = []
for fname, _, buggy, vector, desc in CASES:
    (DEST / "src" / fname).write_text(buggy.lstrip())
    truth.append({"file": f"src/{fname}", "vector": vector, "expected": desc})

# Touch the filler files too, so they land in the diff as genuine noise.
for i in range(FILLER):
    p = DEST / "src" / f"util{i}.py"
    p.write_text(p.read_text() + f"    # tuned {i}\n")

lock = {"lockfileVersion": 3, "packages": {
    f"node_modules/p{i}": {"version": f"1.0.{i}", "integrity": "sha512-" + "C" * 64}
    for i in range(300)}}
(DEST / "package-lock.json").write_text(json.dumps(lock, indent=2))

git("add", "-A")
git("commit", "-qm", "feat: assorted tuning across modules")

(DEST / ".base_ref").write_text(base_sha)
(DEST / ".ground_truth.json").write_text(json.dumps(truth, indent=2))
print(f"base={base_sha}")
print(f"planted={len(truth)} across {len(set(t['vector'] for t in truth))} vectors")
for v in ("LOGIC", "SECURITY", "CONCURRENCY", "PERFORMANCE", "API"):
    n = sum(1 for t in truth if t["vector"] == v)
    print(f"  {v:12s} {n}")
