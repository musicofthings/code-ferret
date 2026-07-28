#!/usr/bin/env node
// Test double for a host agent that takes a while and then succeeds. Unlike
// sleepy-agent.js (which never exits, to exercise runAgent's timeout path),
// this one always finishes, so it can hold the review lock open for a
// deterministic window while a second `ferret review` races it.
//
// FAKE_AGENT_DELAY_MS controls how long it holds; default 750ms.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const delay = Number(process.env.FAKE_AGENT_DELAY_MS ?? 750);

setTimeout(() => {
  const dir = join(process.cwd(), ".ferret");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "last-review.json"),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      target: "all",
      findings: [
        {
          id: "slow-1",
          file: "src/x.ts",
          line: 1,
          character: 1,
          severity: "WARNING",
          vector: "LOGIC",
          confidence: "HIGH",
          message: "Slow-agent probe finding.",
          explanation: "e",
          codegen_instructions: null,
          patch: null,
        },
      ],
      suppressed: 0,
      deduped: 0,
    }),
  );
  process.exit(0);
}, delay);
