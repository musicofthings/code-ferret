#!/usr/bin/env node
// Test double that never exits on its own and ignores SIGTERM, to exercise
// runAgent's timeout path. On POSIX this models a real child that traps or
// ignores SIGTERM (the scenario runAgent's SIGKILL escalation exists for).
// On Windows, kill("SIGTERM") maps to TerminateProcess and always succeeds
// regardless of this handler, so this fixture still lets a Windows test run
// verify timeout detection without hanging.
process.on("SIGTERM", () => {
  // Deliberately do nothing.
});
setInterval(() => {}, 1000);
