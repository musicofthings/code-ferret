/** Raised for contradictory scope flags. Rejected before any review starts. */
export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Resolve CLI scope flags to a collect-context.sh target.
 *
 * Targets: "all" (committed + staged + unstaged, i.e. base..worktree),
 * "uncommitted" (staged + unstaged tracked only), or a base ref string
 * (committed only, base...HEAD).
 */
export function resolveScope(flags = {}, options = {}) {
  const {
    committed = false,
    uncommitted = false,
    includeUntracked = false,
    base = null,
    baseCommit = null,
  } = flags;
  const { defaultBase = "main" } = options;

  if (committed && uncommitted) {
    throw new ScopeError("--committed cannot be combined with --uncommitted");
  }
  if (committed && includeUntracked) {
    throw new ScopeError("--committed cannot be combined with --include-untracked");
  }
  if (base && baseCommit) {
    throw new ScopeError("--base cannot be combined with --base-commit");
  }

  const baseRef = baseCommit || base || defaultBase;

  if (committed) return { target: baseRef, includeUntracked: false, baseRef };
  if (uncommitted) return { target: "uncommitted", includeUntracked, baseRef: null };
  return { target: "all", includeUntracked, baseRef };
}
