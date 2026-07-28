const MAX_CANDIDATES = 5;

/**
 * Quote a path for the copy-pasteable commands below. Directory names with
 * spaces are ordinary ("src/My Components"), and unquoted they produce a
 * suggestion that silently reviews the wrong path or fails outright.
 */
function quotePath(value) {
  return /^[\w./@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Count changed files per parent directory, most-changed first. */
export function topDirectories(files) {
  const counts = new Map();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const dir = slash === -1 ? "." : file.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

/**
 * Suggest mutually exclusive narrower re-run commands for an oversized diff.
 * The CLI never selects one, splits the review, or retries — the user does.
 * Estimates are deliberately conservative.
 */
export function computeCandidates({
  files,
  maxFiles,
  committedFiles = [],
  uncommittedFiles = [],
}) {
  const candidates = [];
  if (committedFiles.length > 0) {
    candidates.push({
      command: "ferret review --committed",
      files: committedFiles.length,
      fits: committedFiles.length <= maxFiles,
    });
  }
  if (uncommittedFiles.length > 0) {
    candidates.push({
      command: "ferret review --uncommitted",
      files: uncommittedFiles.length,
      fits: uncommittedFiles.length <= maxFiles,
    });
  }
  for (const [dir, count] of topDirectories(files)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    candidates.push({
      command: `ferret review --dir ${quotePath(dir)}`,
      files: count,
      fits: count <= maxFiles,
    });
  }
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidatesNote:
      `The selected scope contains ${files.length} files, above the ` +
      `${maxFiles}-file limit. Choose one narrower scope and rerun it ` +
      `manually. Estimates are conservative — a candidate marked over the ` +
      `limit may still fit after filtering.`,
  };
}
