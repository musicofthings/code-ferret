#!/usr/bin/env node
// Test double for a host coding agent. Emits progress lines, then writes the
// canned findings file the real agent's methodology would produce.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.stdout.write("collecting context\n");
process.stdout.write("running analyzers\n");

if (process.env.FAKE_AGENT_FAIL === "1") {
  process.stderr.write("simulated agent failure\n");
  process.exit(3);
}

const dir = join(process.cwd(), ".ferret");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "last-review.json"),
  JSON.stringify({
    generated_at: new Date().toISOString(),
    target: process.env.FAKE_AGENT_TARGET ?? "all",
    findings: [
      {
        id: "f1",
        file: "src/pay.ts",
        line: 84,
        character: 14,
        severity: "CRITICAL",
        vector: "CONCURRENCY",
        confidence: "HIGH",
        message: "Race condition during balance debit.",
        explanation: "Two concurrent debits read the same balance.",
        codegen_instructions: "Wrap the read-modify-write in a transaction.",
        patch: null,
        suppression_hash: "deadbeefdeadbeef",
      },
    ],
  }),
);
process.exit(0);
