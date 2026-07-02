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
