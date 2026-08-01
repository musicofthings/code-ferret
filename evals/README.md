# CodeFerret evals

`tests/run.sh` checks that the machinery works. These evals check that the
review **finds things**. The two fail independently, and the second is the one
that catches design mistakes: the 0.3.0 per-vector fan-out passed every unit
assertion — partition, economics, packing, agent frontmatter — while recalling
6 of 12 planted bugs, because splitting shards by vector showed each vector only
a fifth of the files.

Anything that changes review *topology* or *prompts* should be scored here, not
just unit tested.

## Recall eval

Builds a 23-file repository with a clean baseline commit and a change commit
that plants 12 bugs across all five detection vectors, plus 10 untouched-logic
filler files as noise and a large lockfile churn.

```bash
# 1. build the fixture (prints the base ref)
python3 evals/build_fixture.py /tmp/ferret-eval

# 2. review it however you want to measure — inline, fan-out, CLI, another host
cd /tmp/ferret-eval
BASE=$(cat .base_ref)
FERRET_OUT=.ferret/context.txt bash <plugin>/scripts/collect-context.sh "$BASE"
bash <plugin>/scripts/plan-shards.sh "$BASE" 5     # if measuring a fan-out

# 3. score whatever the review produced
python3 evals/score.py /tmp/ferret-eval /tmp/ferret-eval/.ferret/last-review.json
```

Scoring accepts either a `.ferret/last-review.json` or the raw JSON arrays
produced per batch — pass one file per batch:

```bash
python3 evals/score.py /tmp/ferret-eval shard1.json shard2.json shard3.json
```

`score.py` exits non-zero when recall falls below `--min-recall` (default
`1.0`), so it can gate a change.

### Planted bugs

| file | vector | defect |
|---|---|---|
| `auth.py` | SECURITY | SQL injection via `%`-interpolation |
| `render.py` | SECURITY | XSS: `html.escape` removed |
| `loader.py` | SECURITY | unsafe deserialization: `pickle.loads` |
| `paging.py` | LOGIC | off-by-one past the slice end |
| `parse.py` | LOGIC | unguarded `parts[1]` raises on single-field input |
| `retry.py` | LOGIC | infinite loop: attempt bound dropped |
| `counter.py` | CONCURRENCY | unsynchronized read-modify-write |
| `cache_init.py` | CONCURRENCY | double-checked init without a lock |
| `lookup.py` | PERFORMANCE | O(N·M): dict index replaced by linear scan |
| `report_perf.py` | PERFORMANCE | O(N²): list rebuilt inside the loop |
| `api_client.py` | API | request timeout removed |
| `public_api.py` | API | optional param became required, new required arg |

Every bug is a regression against the baseline commit, so `FERRET_FILE_HISTORY`
can legitimately be used as evidence.

### Recorded results

| configuration | recall |
|---|---|
| per-vector shards, 5 subagents (0.3.0–0.3.1) | 6/12 (50%) |
| per-file shards, 5 subagents (0.3.2+) | 12/12 (100%) |

The per-vector run missed a SQL injection in `auth.py` because that file was
assigned to the API agent and the SECURITY agent never saw it. In
`cache_init.py` the LOGIC agent identified the removed lock, wrote that it
"falls under the CONCURRENCY vector, not LOGIC", and dropped it as instructed —
while no other agent would ever be shown that file.

## Caveats

- Bugs are deliberately unambiguous. Real diffs are subtler, so treat 100% here
  as a floor for basic competence, not evidence of real-world recall.
- The fixture is synthetic. It exercises the review path honestly but is not
  drawn from real review history.
- Scoring matches at file granularity. A finding on the right file for the wrong
  reason still counts, so read the reported findings rather than trusting the
  number alone.
