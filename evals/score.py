#!/usr/bin/env python3
"""Score a CodeFerret review against planted ground truth.

Usage:
    python3 evals/score.py <fixture-dir> <findings.json> [<findings.json> ...]

Findings files may be either a review's `.ferret/last-review.json` or a raw
JSON array as returned by a `ferret-reviewer` subagent. Pass one file per shard
when scoring a fan-out.

Exit status is 1 if recall is below --min-recall (default 1.0), so this can gate
a change the way the unit tests do. Unit tests verify the plumbing; this
verifies that the review actually finds things. The two fail independently: the
0.3.0 per-vector fan-out passed every unit assertion while recalling 6/12.
"""
import argparse
import collections
import json
import pathlib
import sys


def load_findings(path):
    raw = pathlib.Path(path).read_text()
    # Subagents wrap their array in a ```json fence often enough to handle it.
    if "```" in raw:
        chunks = raw.split("```")
        for c in chunks:
            c = c.strip()
            if c.startswith("json"):
                c = c[4:].strip()
            if c.startswith(("[", "{")):
                raw = c
                break
    data = json.loads(raw)
    if isinstance(data, dict):
        data = data.get("findings", [])
    return data


def norm(p):
    """Findings may carry absolute paths; compare on the repo-relative tail."""
    p = str(p).replace("\\", "/")
    i = p.find("src/")
    return p[i:] if i >= 0 else p.rsplit("/", 1)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fixture")
    ap.add_argument("findings", nargs="+")
    ap.add_argument("--min-recall", type=float, default=1.0)
    args = ap.parse_args()

    fixture = pathlib.Path(args.fixture)
    truth = json.loads((fixture / ".ground_truth.json").read_text())

    reported = []
    for f in args.findings:
        reported.extend(load_findings(f))

    hit_files = {norm(f.get("file", "")) for f in reported}
    planted = {norm(t["file"]): t for t in truth}

    found = [p for p in planted if p in hit_files]
    missed = [p for p in planted if p not in hit_files]
    # A report on a file with no planted bug: either a real extra find or noise.
    extra = sorted(hit_files - set(planted))

    print(f"{'file':24s} {'planted vector':14s} {'result'}")
    print("-" * 52)
    for p, t in sorted(planted.items(), key=lambda kv: (kv[1]["vector"], kv[0])):
        print(f"{p:24s} {t['vector']:14s} {'FOUND' if p in hit_files else 'MISSED'}")
    print("-" * 52)

    recall = len(found) / len(planted) if planted else 0.0
    print(f"recall   {len(found)}/{len(planted)} = {recall:.0%}")
    print(f"findings reported: {len(reported)}")
    if extra:
        print(f"reported on {len(extra)} file(s) with no planted bug "
              f"(may be genuine, review manually): {', '.join(extra)}")

    by_vec = collections.Counter(planted[p]["vector"] for p in missed)
    if by_vec:
        print("misses by vector: " + ", ".join(f"{v}={n}" for v, n in sorted(by_vec.items())))

    if recall < args.min_recall:
        print(f"\nFAIL: recall {recall:.0%} below required {args.min_recall:.0%}")
        return 1
    print(f"\nPASS: recall meets the {args.min_recall:.0%} bar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
