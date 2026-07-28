#!/usr/bin/env node
// Test double that reports back exactly what argv it received, on a single
// line (JSON.stringify escapes any embedded newlines as "\n" text, so this
// never emits a raw newline byte itself). Used to verify runAgent delivers
// prompt content to the child's argv byte-for-byte, with no shell
// interpretation of quotes, %-expansion, or shell metacharacters.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
