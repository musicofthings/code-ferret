import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  acquireReviewLock, releaseLock, releaseReviewLock, inspectLock, isStale,
  LockBusyError, LOCK_NAME, STALE_MS, LEASE_MS,
} from "../src/lock.js";

const newDir = () => join(mkdtempSync(join(tmpdir(), "ferret-lock-")), ".ferret");
const lockPath = (dir) => join(dir, LOCK_NAME);

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

function writeLock(dir, lock) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir), JSON.stringify(lock));
}

test("acquiring creates the lock file and records the holder", async () => {
  const dir = newDir();
  const lock = await acquireReviewLock(dir, { target: "all" });
  assert.equal(existsSync(lockPath(dir)), true);
  const held = JSON.parse(readFileSync(lockPath(dir), "utf8"));
  assert.equal(held.pid, process.pid);
  assert.equal(held.host, hostname());
  assert.equal(held.target, "all");
  assert.ok(Number.isFinite(Date.parse(held.started_at)));
  await lock.release();
});

test("a second acquire fails while the first is held", async () => {
  const dir = newDir();
  const first = await acquireReviewLock(dir);
  await assert.rejects(() => acquireReviewLock(dir), LockBusyError);
  await first.release();
});

test("the busy error names the holder and how to clear it", async () => {
  const dir = newDir();
  const first = await acquireReviewLock(dir);
  const err = await acquireReviewLock(dir).catch((e) => e);
  assert.ok(err instanceof LockBusyError);
  assert.match(err.message, new RegExp(`pid ${process.pid}`));
  assert.match(err.message, /review\.lock/);
  assert.equal(err.holder.pid, process.pid);
  await first.release();
});

test("releasing lets the next acquire through", async () => {
  const dir = newDir();
  const first = await acquireReviewLock(dir);
  await first.release();
  assert.equal(existsSync(lockPath(dir)), false);
  const second = await acquireReviewLock(dir);
  await second.release();
});

test("release is idempotent and never throws", async () => {
  const dir = newDir();
  const lock = await acquireReviewLock(dir);
  await lock.release();
  await lock.release();
  await releaseLock(join(dir, "definitely-not-there.lock"));
});

test("a lock held by a dead process on this host is reclaimed", async () => {
  const dir = newDir();
  writeLock(dir, {
    pid: DEAD_PID, host: hostname(), started_at: new Date().toISOString(),
  });
  const lock = await acquireReviewLock(dir);
  assert.equal(JSON.parse(readFileSync(lockPath(dir), "utf8")).pid, process.pid);
  await lock.release();
});

test("an unparseable lock file is reclaimed rather than wedging the CLI forever", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir), "{ half-written");
  const lock = await acquireReviewLock(dir);
  await lock.release();
});

test("a lock older than the stale window is reclaimed even if the pid is live", async () => {
  const dir = newDir();
  // process.pid is genuinely alive, so only the age can justify reclaiming --
  // this is the backstop for a crashed holder whose pid was later reused.
  writeLock(dir, {
    pid: process.pid,
    host: hostname(),
    started_at: new Date(Date.now() - STALE_MS - 1000).toISOString(),
  });
  const lock = await acquireReviewLock(dir);
  await lock.release();
});

test("a fresh lock from another host is respected, not pid-checked", async () => {
  // The pid below is dead *here*, but on the host that wrote the lock that
  // number refers to some unrelated process. Reclaiming on a liveness check
  // would steal a lock whose owner is still running elsewhere.
  const dir = newDir();
  writeLock(dir, {
    pid: DEAD_PID, host: "some-other-machine", started_at: new Date().toISOString(),
  });
  await assert.rejects(() => acquireReviewLock(dir), LockBusyError);
});

test("isStale treats a missing timestamp as reclaimable", () => {
  const now = Date.now();
  assert.equal(isStale(null, { host: hostname(), now }), true);
  assert.equal(isStale({ pid: process.pid, host: hostname() }, { host: hostname(), now }), true);
});

test("isStale keeps a live same-host holder", () => {
  const now = Date.now();
  const lock = { pid: process.pid, host: hostname(), started_at: new Date(now).toISOString() };
  assert.equal(isStale(lock, { host: hostname(), now }), false);
});

test("concurrent acquires produce exactly one winner", async () => {
  const dir = newDir();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => acquireReviewLock(dir)),
  );
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, "exactly one acquire may succeed");
  for (const lost of results.filter((r) => r.status === "rejected")) {
    assert.ok(lost.reason instanceof LockBusyError);
  }
  await won[0].value.release();
});

// --- leased locks (the MCP prompt-driven flow) ----------------------------
//
// The MCP server acquires in one tool call and releases in another, so its own
// pid stays alive for the whole session regardless of whether the agent is
// still reviewing, finished without releasing, or abandoned the conversation.
// Process liveness therefore says nothing, and an explicit lease is the only
// thing that can free an abandoned review.

test("a fresh lease blocks another acquire even from a live process", async () => {
  const dir = newDir();
  const held = await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS });
  assert.ok(held.holder.expires_at);
  await assert.rejects(() => acquireReviewLock(dir), LockBusyError);
});

test("an expired lease is reclaimed even though the holder pid is alive", async () => {
  const dir = newDir();
  // process.pid is genuinely alive and the lock is only seconds old, so under
  // the process-lifetime rules this would still be held. The lease overrides.
  writeLock(dir, {
    pid: process.pid,
    host: hostname(),
    kind: "mcp",
    token: "t",
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const lock = await acquireReviewLock(dir);
  await lock.release();
});

test("releasing a leased lock requires the right token", async () => {
  const dir = newDir();
  const held = await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS });

  const wrong = await releaseReviewLock(dir, { token: "not-the-token" });
  assert.equal(wrong.released, false);
  assert.match(wrong.reason, /different review/);
  assert.equal(existsSync(lockPath(dir)), true, "a failed release must not drop the lock");

  const right = await releaseReviewLock(dir, { token: held.token });
  assert.equal(right.released, true);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("force releases a lock held by someone else", async () => {
  const dir = newDir();
  await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS });
  const result = await releaseReviewLock(dir, { force: true });
  assert.equal(result.released, true);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("releasing when nothing is held says so rather than pretending", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  const result = await releaseReviewLock(dir, { token: "anything" });
  assert.equal(result.released, false);
  assert.match(result.reason, /no review lock is held/);
});

test("a leased lock and the CLI contend on the same lock file", async () => {
  // The whole point: an MCP prompt-driven review and `ferret review` must not
  // both run against one repository.
  const dir = newDir();
  const mcp = await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS });
  await assert.rejects(() => acquireReviewLock(dir, { kind: "cli" }), LockBusyError);
  await releaseReviewLock(dir, { token: mcp.token });
  const cli = await acquireReviewLock(dir, { kind: "cli" });
  await assert.rejects(
    () => acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS }),
    LockBusyError,
  );
  await cli.release();
});

test("inspectLock reports the holder, and nothing once the lease expires", async () => {
  const dir = newDir();
  const held = await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS, target: "head" });
  const holder = await inspectLock(dir);
  assert.equal(holder.kind, "mcp");
  assert.equal(holder.target, "head");
  assert.equal(holder.token, held.token);
  // Same file, evaluated past the lease: reported as free.
  assert.equal(await inspectLock(dir, { now: Date.now() + LEASE_MS + 1000 }), null);
});

test("the busy message names an MCP holder as such, not as a terminal review", async () => {
  const dir = newDir();
  await acquireReviewLock(dir, { kind: "mcp", ttlMs: LEASE_MS });
  const err = await acquireReviewLock(dir).catch((e) => e);
  assert.ok(err instanceof LockBusyError);
  assert.match(err.message, /MCP CodeFerret review/);
  assert.doesNotMatch(err.message, /ferret review` is already/);
  assert.match(err.message, /lease expires/);
});
