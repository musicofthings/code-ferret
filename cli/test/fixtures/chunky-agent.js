#!/usr/bin/env node
// Test double that writes deliberately awkward partial chunks, with small
// delays between writes so each write() lands as its own 'data' event on the
// parent's side. Exercises runAgent's line-buffering byte-for-byte: a line
// split mid-line across two chunks, a \r\n line ending that must be
// stripped, a multibyte UTF-8 character split mid-sequence across a chunk
// boundary, and a final line with no trailing newline that must be flushed
// on close.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // "first line\n" split mid-line across two chunks.
  process.stdout.write("fir");
  await wait(15);
  process.stdout.write("st line\n");

  // CRLF line ending -- must be stripped down to "second line".
  await wait(15);
  process.stdout.write("second line\r\n");

  // A multibyte UTF-8 character ("日", the 3-byte sequence E6 97 A5) split
  // mid-sequence across two chunks. Must decode as "日", not U+FFFD.
  const utf8 = Buffer.from("third 日本語 line\n", "utf8");
  const cut = utf8.indexOf(0xe6); // first byte of "日"'s 3-byte sequence
  process.stdout.write(utf8.subarray(0, cut + 1));
  await wait(15);
  process.stdout.write(utf8.subarray(cut + 1));

  // Final line with no trailing newline -- must be flushed when the process closes.
  await wait(15);
  process.stdout.write("unterminated last line");
}

main();
