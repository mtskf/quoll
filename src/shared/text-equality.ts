// EOL-insensitive content equality, asked on BOTH sides of the wire about the
// SAME document: the host's `contentMatches` (session/host-session-core.ts —
// applyEditSettled's foreign-bytes, drain-eligibility and ok-but-mismatch
// checks) and the webview's loss judgement (cm/edit-sync.ts —
// `lostToSupersession`, "does the authoritative document still carry these
// un-acked bytes?"). The two were byte-identical hand copies, regex included;
// this is the single definition so they cannot drift. One-sided drift is
// user-visible in BOTH directions — widen the host's and the webview announces
// a discard on every epoch advance, widen the webview's and a real loss goes
// unannounced.
// Pure + dependency-free so it crosses the host/webview bundle boundary from
// src/shared/ (no vscode, no DOM).

/** Do `a` and `b` carry the same TEXT, ignoring line endings? CRLF and lone CR
 *  both normalise to LF before the compare, so an EOL-only difference reads as
 *  equal — routine skew between the two sides, since the host canonicalises to
 *  `document.eol` while the webview holds whatever its CM `lineSeparator` facet
 *  had. The `a === b` fast path runs first: byte-identical is the common case and
 *  stays allocation-free, and the normalise is paid only when the strings already
 *  differ. Whitespace other than line endings is NOT normalised — a trailing
 *  space is a real difference. */
export function sameTextIgnoringEol(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n|\r|\n/g, "\n") === b.replace(/\r\n|\r|\n/g, "\n");
}
