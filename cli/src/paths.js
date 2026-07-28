import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the CodeFerret installation, in priority order:
 * 1. CODEFERRET_ROOT env override, 2. the repo checkout this CLI lives in,
 * 3. a vendored copy next to the CLI. Mirrors mcp-server/server/index.js.
 */
export function ferretRoot() {
  const override = process.env.CODEFERRET_ROOT;
  if (override && existsSync(join(override, "scripts", "collect-context.sh"))) {
    return override;
  }
  const checkout = resolve(SRC_DIR, "..", "..");
  if (existsSync(join(checkout, "scripts", "collect-context.sh"))) return checkout;
  return resolve(SRC_DIR, "..", "vendor");
}

export function scriptPath(name) {
  return join(ferretRoot(), "scripts", name);
}

export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Pass `root` when the caller already resolved it, to skip a redundant git spawn. */
export function ferretDir(cwd, root = repoRoot(cwd)) {
  return root ? join(root, ".ferret") : null;
}
