#!/usr/bin/env node
/** Cross-platform test entry: runs only `*.test.js`, never fixture scripts. */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => join(dir, name))
  .sort();
if (files.length === 0) {
  console.error("no test/*.test.js files found");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
