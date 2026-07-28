import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_NAME = "review.lock";

/**
 * How long a lock may sit before another process is allowed to reclaim it.
 *
 * runAgent's own ceiling is 30 minutes (agent.js), after which it SIGTERMs and
 * then SIGKILLs the child. This is deliberately well past that: a lock younger
 * than this belonging to a process we cannot prove is dead is treated as live,
 * so the failure mode of a wrong guess is "you wait", not "two agents write
 * last-review.json at once".
 */
export const STALE_MS = 45 * 60 * 1000;

/** Raised when another `ferret review` holds the lock. */
export class LockBusyError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Missing, truncated, or half-written: nothing here identifies a live
    // holder, so callers treat it as reclaimable.
    return null;
  }
}

/** True when `pid` currently exists. Signal 0 performs the check without sending. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user -- alive.
    return err.code === "EPERM";
  }
}

/**
 * Whether an existing lock may be reclaimed.
 *
 * Two independent signals, because neither alone is sufficient:
 *
 * - PID liveness is precise but only meaningful on the machine that wrote the
 *   lock. On a shared or network checkout another host's PID number refers to
 *   an unrelated local process, so a liveness check there would happily
 *   "reclaim" a lock whose owner is still running elsewhere. When the host
 *   differs we fall back to age alone.
 * - Age alone is too blunt on its own (a genuinely long review would be
 *   stolen), but it is the only backstop against a crashed holder whose PID
 *   was later reused by an unrelated process.
 */
export function isStale(lock, { host, now }) {
  if (!lock) return true;
  const started = Date.parse(lock.started_at ?? "");
  const age = now - started;
  if (!Number.isFinite(age) || age > STALE_MS) return true;
  // A lock stamped in the future is a clock skew artifact, not a live holder
  // we can reason about -- fall through to the identity check rather than
  // treating a negative age as "fresh forever".
  if (lock.host !== host) return false;
  return !pidAlive(lock.pid);
}

function describeHolder(holder) {
  if (!holder) return "another `ferret review` is already running on this repository";
  const who = holder.pid ? `pid ${holder.pid}` : "an unknown process";
  const where = holder.host ? ` on ${holder.host}` : "";
  const when = holder.started_at ? `, started ${holder.started_at}` : "";
  return `another \`ferret review\` is already running on this repository (${who}${where}${when})`;
}

/**
 * Take the per-repository review lock, or throw LockBusyError.
 *
 * Serializes `ferret review` invocations against one .ferret directory. Without
 * it, two overlapping runs (two terminals, or concurrent MCP tool calls) race:
 * each deletes last-review.json out from under the other, whichever agent
 * finishes last silently wins both last-review.json and history.jsonl, and a
 * concurrent `ferret review findings` can observe the gap where neither exists.
 *
 * Deliberately fails fast rather than queueing. A review runs for minutes, so
 * blocking would look identical to a hang; an immediate, specific error lets
 * the caller decide whether to wait or to stop the other run.
 */
export async function acquireReviewLock(
  ferretDir,
  { target = null, pid = process.pid, host = hostname(), now = Date.now() } = {},
) {
  await mkdir(ferretDir, { recursive: true });
  const path = join(ferretDir, LOCK_NAME);
  const payload = JSON.stringify({
    pid,
    host,
    target,
    started_at: new Date(now).toISOString(),
  });

  // Two passes at most: the first may find a stale lock to clear, the second
  // is the real attempt. Anything beyond that means a genuine contender keeps
  // winning, which is a busy lock, not something to spin on.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      // "wx" is O_CREAT|O_EXCL: the create-or-fail is atomic at the filesystem
      // level, so two processes arriving together cannot both believe they won.
      handle = await open(path, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = await readLock(path);
      if (!isStale(holder, { host, now })) {
        throw new LockBusyError(
          `${describeHolder(holder)}. Wait for it to finish, or remove `
            + `${join(ferretDir, LOCK_NAME)} if you are sure it is not.`,
          holder,
        );
      }
      // Stale: clear it and let the loop retry. If a third process wins the
      // recreate in between, the next open throws EEXIST against a fresh lock,
      // which is no longer stale -- so we report busy rather than stealing it.
      await rm(path, { force: true });
      continue;
    }
    try {
      await handle.writeFile(payload);
    } finally {
      await handle.close();
    }
    return { path, release: () => releaseLock(path) };
  }

  throw new LockBusyError(describeHolder(await readLock(path)), null);
}

/**
 * Drop the lock. Never throws: this runs in a finally, and masking the real
 * failure of a review with a cleanup error would be strictly worse.
 */
export async function releaseLock(path) {
  try {
    await rm(path, { force: true });
  } catch { /* best effort */ }
}
