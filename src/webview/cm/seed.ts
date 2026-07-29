// The canonical CM document's seed path: how raw host Markdown becomes a
// CodeMirror line model. Pure (@codemirror/state only, no DOM), so it is the
// SINGLE source of truth shared by editor.ts#applyDocument and the round-trip
// parity gate (test/markdown/round-trip.test.ts) — the two cannot drift.

import { Text } from "@codemirror/state";

/** Detect the document's line separator for the CodeMirror `lineSeparator`
 *  facet. A single CRLF anywhere ⇒ CRLF; absent any \r\n ⇒ LF.
 *
 *  The host seeds canonicalDocumentText(document) (src/extension/
 *  document-canonical.ts), so `rawText` arrives uniform and this picks that
 *  one separator. The CR-only / mixed branch (no `\r\n` ⇒ LF) is defensive —
 *  it keeps the line model clean if a non-uniform string ever reached the
 *  seam — but the host boundary, not this function, owns the single-EOL
 *  invariant.
 *
 *  Note: a lone CR (`\r` not followed by `\n`) is not a supported input — the
 *  CM text model splits on /\r\n?|\n/ (see `splitToCmText`), which strips a
 *  lone `\r`, so a CR-only source cannot round-trip identity. */
export function detectLineSeparator(rawText: string): "\r\n" | "\n" {
  return rawText.includes("\r\n") ? "\r\n" : "\n";
}

/** Split `rawText` into the clean CodeMirror `Text` line model the editor
 *  seeds regardless of `lineSeparator` facet timing. The split on /\r\n?|\n/
 *  strips a CRLF's `\r`, so the resulting `Text`'s length is the LF-internal
 *  UTF-16 code-unit count — which is exactly what CM selection positions are
 *  measured in (the facet affects only the `sliceDoc` render, not the
 *  underlying `doc.length`). */
export function splitToCmText(rawText: string): Text {
  return Text.of(rawText.split(/\r\n?|\n/));
}

/** Compute the minimal single-span change that rewrites `oldDoc` (the live CM
 *  document) into `newDoc` (the host snapshot, already LF-normalised via
 *  {@link splitToCmText}). BOTH operands are CM `Text`, so the offsets are in
 *  CodeMirror's LF-internal coordinate space (`doc.length`) — the caller MUST
 *  pass `view.state.doc`, NOT `view.state.sliceDoc()`. `sliceDoc()` renders with
 *  the `lineSeparator` facet (`\r\n` for a CRLF doc), which would inflate the
 *  offsets and could push `to` past `doc.length` (a `RangeError` on dispatch, or
 *  a silently shifted insert); `Text.toString()` always joins with `\n`.
 *
 *  Trimming the common prefix + suffix is what keeps an external reseed from
 *  springing every fold open: `applyDocument`'s reseed used a wholesale
 *  `{from: 0, to: doc.length}` replace, and CodeMirror maps ALL `foldState`
 *  ranges through that delete — a whole-doc delete drops them, so any external
 *  touch unfolds the document. A minimal span only maps away ranges that overlap
 *  the actual edit; everything outside survives.
 *
 *  The result is content-exact regardless of surrogate boundaries: the applied
 *  doc is `oldStr[0..from) + insert + oldStr[to..)`, and by construction the two
 *  outer slices equal `newDoc`'s prefix/suffix and `insert` is
 *  `newDoc.slice(from, newLen - suffix)`, so the concatenation reassembles
 *  `newDoc` even if `from`/`to` fall inside a surrogate pair. No surrogate
 *  special-casing is required. `insert` is a sub-`Text` (no re-split). The change
 *  is empty (`from === to`, `insert.length === 0`) iff the two docs are
 *  content-identical. */
export function computeReseedChange(
  oldDoc: Text,
  newDoc: Text
): { from: number; to: number; insert: Text } {
  const oldStr = oldDoc.toString();
  const newStr = newDoc.toString();
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  const maxPrefix = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < maxPrefix && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) {
    prefix++;
  }
  // Suffix must not reach back past the prefix on either side (prevents a
  // negative-length span when the two shared runs overlap, e.g. "aaa"->"aa").
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    from: prefix,
    to: oldLen - suffix,
    insert: newDoc.slice(prefix, newLen - suffix),
  };
}
