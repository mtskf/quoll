// The prefix/suffix scan behind both minimal-edit seams: the host write path's
// `minimalEditSpan` (src/extension/document-write/minimal-edit.ts, fuzz-verified
// by its property test) and the webview reseed's `computeReseedChange`
// (src/webview/cm/seed.ts). Both reduce a whole-document replace to the smallest
// single contiguous span by trimming the longest common prefix, then the longest
// common suffix that does not reach back past that prefix. Extracted so a future
// correctness fix reaches both sides of the host/webview boundary at once.
//
// Returns the two run LENGTHS, not a {from,to} span, because each caller layers
// its own transform on top: the host snaps CRLF boundaries (mutating BOTH counts)
// before deriving from/to, while the webview derives from/to directly. Each then
// slices its own `insert` (`string.slice` vs `Text.slice`) from [prefix, len - suffix).
//
// Offsets are UTF-16 code units (`charCodeAt`) — the unit both callers measure in
// (VS Code positionAt / CodeMirror doc.length). Pure + dependency-free so it
// crosses the host/webview bundle boundary from src/shared/ (no vscode, no DOM).

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
