// The string prefix/suffix scan behind the host write path's `minimalEditSpan`
// (src/extension/document-write/minimal-edit.ts, fuzz-verified by its property
// test): it reduces a whole-document replace to the smallest single contiguous
// span by trimming the longest common prefix, then the longest common suffix
// that does not reach back past that prefix.
//
// The webview reseed's `computeReseedChange` (src/webview/cm/seed.ts) applies the
// SAME algorithm but cannot call this core: it holds two CodeMirror `Text` trees,
// and this scan needs O(1) random access (`charCodeAt`) that `Text` does not
// offer. Flattening both docs to reuse this would defeat the reseed's whole point
// (avoid materialising two full-document strings on a large uncapped reseed), so
// it walks the trees chunk-by-chunk instead — a hand-rolled mirror of this logic,
// kept in lockstep by the parity test in test/webview/cm-seed-reseed-change.test.ts.
//
// Returns the two run LENGTHS, not a {from,to} span, because the host layers its
// own transform on top: it snaps CRLF boundaries (mutating BOTH counts) before
// deriving from/to, then slices its `insert` (`string.slice`) from [prefix, len - suffix).
//
// Offsets are UTF-16 code units (`charCodeAt`) — the unit the host measures in
// (VS Code positionAt). Pure + dependency-free so it can live in src/shared/
// (no vscode, no DOM).

/** Longest common prefix + suffix lengths of `oldText`/`newText`, in UTF-16
 *  code units. `suffix` never reaches back past `prefix` on either side, so
 *  `from = prefix` and `to = oldLen - suffix` always form a non-negative span
 *  even when the two shared runs overlap (e.g. "aaa" -> "aa"). */
export function commonAffixLengths(
  oldText: string,
  newText: string
): { prefix: number; suffix: number } {
  const oldLen = oldText.length;
  const newLen = newText.length;
  const maxPrefix = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  // Cap the suffix at the chars the prefix has not already claimed (prevents a
  // negative-length span when the two shared runs overlap, e.g. "aaa" -> "aa").
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return { prefix, suffix };
}
