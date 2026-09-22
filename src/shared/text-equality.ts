// EOL-insensitive content equality, asked on BOTH sides of the wire about the
// SAME document: the host's `contentMatches` (session/host-session-core.ts —
// applyEditSettled's foreign-bytes, drain-eligibility and ok-but-mismatch
// checks) and the webview's loss judgement (cm/edit-sync.ts —
// `lostToSupersession`, "does the authoritative document still carry these
// un-acked bytes?"). The two were byte-identical hand copies, regex included;
// this is the single definition so they cannot drift. One-sided drift is
// user-visible on EITHER side, and the symptoms are per-side. The host's
// predicate gates the externalEpoch bump (foreignAtSettle): NARROW it and a
// routine EOL skew scores the webview's own ack as foreign — the epoch advances,
// the view is reseeded back to the acked bytes (no fold on a moved lineage) and
// the webview drops the replay buffer unconditionally, so keystrokes typed
// during the in-flight window are lost for nothing — a REAL loss the notice then
// correctly announces (the webview's own predicate, unchanged, sees the Document
// does not carry them); WIDEN it and genuine foreign bytes read as ours, so no
// epoch advances and a stale buffer replays over them. The webview's predicate is the
// notice's SECOND conjunct: NARROW it and an epoch advance whose Document does
// carry the bytes announces a discard that did not happen; WIDEN it and a real
// loss goes unannounced.
// Pure + dependency-free so it crosses the host/webview bundle boundary from
// src/shared/ (no vscode, no DOM).

/** Do `a` and `b` carry the same TEXT, ignoring line endings? CRLF and lone CR
 *  both normalise to LF before the compare, so an EOL-only difference reads as
 *  equal — routine skew between the two sides, since the host canonicalises to
 *  `document.eol` while the webview serialises with whatever EOL its
 *  `quollDocumentEol` facet holds (src/webview/cm/seed.ts). The `a === b` fast
 *  path runs first: byte-identical is the common case and stays allocation-free,
 *  and the normalise is paid only when the strings already differ. Whitespace
 *  other than line endings is NOT normalised — a trailing space is a real
 *  difference. */
export function sameTextIgnoringEol(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n|\r|\n/g, "\n") === b.replace(/\r\n|\r|\n/g, "\n");
}
