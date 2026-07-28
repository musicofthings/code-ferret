#!/usr/bin/env node
// Test double for a host agent that writes a single finding whose severity
// is controlled by the caller via FAKE_SEVERITY. Used to verify the CLI
// normalizes/validates severity before trusting it for tallying (see
// review.js's bySeverity computation and report.js's formatReport) --
// severity strings come straight from LLM-authored JSON, so a lowercase
// value or a prototype-colliding key like "constructor" is not hypothetical.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
        file: "src/x.ts",
        line: 1,
        character: 1,
        severity: process.env.FAKE_SEVERITY ?? "CRITICAL",
        vector: "logic",
        confidence: "HIGH",
        message: "Severity-normalization probe finding.",
        explanation: "e",
        codegen_instructions: null,
        patch: null,
      },
    ],
  }),
);
process.exit(0);
