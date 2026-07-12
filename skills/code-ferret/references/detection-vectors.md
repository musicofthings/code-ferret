# Detection Vectors — analysis checklists

Work through each vector for every changed hunk. A finding must name the
concrete input, state, or interleaving that triggers the failure.

## LOGIC — run-time integrity

- **Boundary conditions**: `<` vs `<=` at loop bounds, `len(x)` vs `len(x)-1`
  indexing, empty-collection paths, first/last-element special cases.
- **Null/undefined flow**: values that can be null/None/undefined reaching a
  dereference; optional chaining that silently swallows a required value;
  functions that return `null` on one path and throw on another.
- **Unhandled async failures**: promises without `.catch`/`await` inside
  try, fire-and-forget async calls whose errors vanish, missing `await`
  turning a value into a coroutine/promise object.
- **Resource leaks**: file handles, sockets, DB connections, subprocesses, or
  locks acquired without a finally/defer/context-manager release on error paths.
- **Infinite loops / non-termination**: loop variables not advanced on all
  branches, retry loops without a bound, recursion without a base case on some
  input class.
- **Regression check**: if `git log -L` shows the changed lines were previously
  fixed for a bug and the change reintroduces the old shape → HIGH confidence.

## SECURITY — SAST

- **Hardcoded secrets**: API keys, tokens, passwords, private keys in source.
  Cross-check with `scan-secrets.sh`. Never quote the secret value.
- **Injection**: SQL/NoSQL built by string concatenation or f-strings with
  user-reachable input; shell commands interpolating unsanitized variables;
  path traversal via user-supplied filenames.
- **XSS**: user input rendered into HTML without escaping (`innerHTML`,
  `dangerouslySetInnerHTML`, template `| safe` filters).
- **Unsafe deserialization**: `pickle.loads`, `yaml.load` without SafeLoader,
  `eval`/`exec` / `Function()` on external data.
- **AuthZ/AuthN gaps introduced by the diff**: removed permission checks,
  widened CORS origins to `*` with credentials, disabled TLS verification,
  weakened crypto (MD5/SHA1 for auth, static IVs, `Math.random` for tokens).

## CONCURRENCY — asynchronous safety

- **Read-modify-write races**: read a value, compute, write back across an
  await/thread boundary without a transaction, lock, or atomic op (the classic
  balance-debit bug).
- **Check-then-act (TOCTOU)**: existence/permission checks separated from the
  action that relies on them.
- **Shared mutable state**: module-level or singleton state mutated from
  concurrent handlers; lazily-initialized globals without synchronization.
- **Deadlocks**: multiple locks acquired in inconsistent order; awaiting a
  result that needs the lock currently held.
- **Pool/connection misuse**: connections used across concurrent tasks,
  unsynchronized access to non-thread-safe clients.

## PERFORMANCE — resource conservation

- **Algorithmic blowups**: nested loops or `.includes`/`in`-list scans inside a
  loop over data that can be large in production (O(N²) where a set/map gives
  O(N)).
- **N+1 queries**: a query, HTTP call, or file read inside a loop over records
  that could be batched, joined, or prefetched.
- **Redundant allocations**: rebuilding regexes/clients/parsers inside hot
  loops, repeated deep copies, string concatenation in loops where a builder
  belongs.
- **Missing memoization**: pure, expensive computation repeated with identical
  inputs on a hot path.

Only flag PERFORMANCE when the data can plausibly be large or the path is hot —
an O(N²) over a config list of five entries is noise.

## API — contract enforcement

- **Breaking public changes**: renamed/removed exports, changed parameter order
  or types, narrowed return types, altered JSON response shapes — verify by
  grepping for callers/consumers.
- **Type-safety violations**: casts that bypass the type system (`as any`,
  `# type: ignore`, `unsafe`), mismatches between runtime behavior and declared
  types.
- **SDK/library misuse**: calling third-party APIs against their documented
  contract (missing required cleanup calls, deprecated/removed methods after a
  version bump in the same diff).
- **Serialization drift**: DB schema, protobuf, or API-model changes without
  corresponding migration/versioning.

## Confidence calibration

| Rating | Bar |
|---|---|
| HIGH | Structural proof: you traced a concrete input/state to the failure; or a secret/injection pattern is unambiguous. |
| MEDIUM | Defect pattern clearly present, but an invariant you cannot see (caller guarantees, single-threaded deployment, sanitized upstream) could make it safe. |
| LOW | Smell worth a human look; do not claim it is broken. |

Severity is independent of confidence:

- **CRITICAL** — crashes in production, data loss/corruption, or a security flaw.
- **WARNING** — works today but fails on edge cases or degrades badly at scale.
- **SUGGESTION** — correct code that violates idiom, readability, or architecture.
