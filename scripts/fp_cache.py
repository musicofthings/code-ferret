#!/usr/bin/env python3
"""CodeFerret false-positive suppression cache.

Stores structural hashes of findings a human dismissed as false positives or
intentional choices, at <repo-root>/.ferret/review-cache.json.

Usage:
  fp_cache.py hash  <file> <vector> <message>            -> print suppression hash
  fp_cache.py check <file> <vector> <message>            -> exit 0 if suppressed, 3 if not
  fp_cache.py add   <file> <vector> <message> [reason]   -> record suppression
  fp_cache.py list                                       -> dump cache entries
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone


def repo_root() -> str:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        print("error: not a git repository", file=sys.stderr)
        sys.exit(2)
    return out.stdout.strip()


def cache_path() -> str:
    return os.path.join(repo_root(), ".ferret", "review-cache.json")


def load_cache() -> dict:
    try:
        with open(cache_path()) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": 1, "suppressions": {}}


def save_cache(cache: dict) -> None:
    path = cache_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(cache, f, indent=2, sort_keys=True)
        f.write("\n")


def normalize(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"\d+", "N", text)
    text = re.sub(r"\s+", " ", text)
    return text


def suppression_hash(file: str, vector: str, message: str) -> str:
    basename = os.path.basename(file)
    key = f"{basename}|{vector.upper()}|{normalize(message)}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[1]

    if cmd == "list":
        print(json.dumps(load_cache(), indent=2))
        return

    if cmd not in ("hash", "check", "add") or len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        sys.exit(2)

    file, vector, message = sys.argv[2], sys.argv[3], sys.argv[4]
    h = suppression_hash(file, vector, message)

    if cmd == "hash":
        print(h)
    elif cmd == "check":
        if h in load_cache()["suppressions"]:
            print(f"suppressed {h}")
            sys.exit(0)
        print(f"not-suppressed {h}")
        sys.exit(3)
    elif cmd == "add":
        cache = load_cache()
        cache["suppressions"][h] = {
            "file": os.path.basename(file),
            "vector": vector.upper(),
            "message": message,
            "reason": sys.argv[5] if len(sys.argv) > 5 else "false positive",
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        save_cache(cache)
        print(f"added {h}")


if __name__ == "__main__":
    main()
