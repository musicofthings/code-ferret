#!/usr/bin/env node
import { main } from "../src/index.js";

// A downstream reader closing early (`ferret review --agent | head`, `| jq`,
// a pager) is normal for a JSONL-emitting CLI. Without this, Node's default
// unhandled 'error' on a pipe write crashes the process with a raw EPIPE
// stack trace instead of exiting quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
