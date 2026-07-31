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
 *  content-identical.
 *
 *  Memory: the prefix/suffix runs are scanned chunk-by-chunk over the two `Text`
 *  trees via {@link commonRunLength} — neither document is flattened to a full
 *  string. This matters because the host→webview content path is deliberately
 *  uncapped (no `MAX_CONTENT_LENGTH`), so a large externally-changed file would
 *  otherwise transiently hold both `Text` structures AND two full-document
 *  strings. Only the divergent middle is ever materialised, as the `insert`
 *  sub-`Text`. The scan mirrors the shared string core `commonAffixLengths`
 *  (src/shared/minimal-span.ts) — same longest-common-prefix-then-capped-suffix
 *  logic — and test/webview/cm-seed-reseed-change.test.ts pins the two in
 *  lockstep. It cannot reuse that core directly: the core needs O(1) random
 *  access (`charCodeAt`), which `Text` does not offer — its cheap primitive is
 *  sequential chunk iteration, and reusing the core would mean flattening (the
 *  allocation this avoids) or O(n log n) per-char slicing. */
export function computeReseedChange(
  oldDoc: Text,
  newDoc: Text
): { from: number; to: number; insert: Text } {
  const oldLen = oldDoc.length;
  const newLen = newDoc.length;
  // Longest common prefix, naturally bounded by the shorter document.
  const maxPrefix = Math.min(oldLen, newLen);
  const prefix = commonRunLength(oldDoc, newDoc, maxPrefix, 1);
  // Longest common suffix, capped at the code units the prefix has not already
  // claimed — the non-negative-span guard (keeps `from <= to` when the shared
  // prefix and suffix runs overlap, e.g. "aaa" -> "aa"). Mirrors
  // commonAffixLengths' `maxSuffix = maxPrefix - prefix`.
  const suffix = commonRunLength(oldDoc, newDoc, maxPrefix - prefix, -1);
  // The webview needs no CRLF snap because both operands are already LF-internal
  // (see splitToCmText). `insert` is a sub-`Text` (no re-split, no flatten).
  return {
    from: prefix,
    to: oldLen - suffix,
    insert: newDoc.slice(prefix, newLen - suffix),
  };
}

/** Count the leading (`dir` 1) or trailing (`dir` -1) UTF-16 code units shared
 *  by two CM `Text` docs, capped at `max`. Walks both trees chunk-by-chunk with
 *  `Text.iter(dir)` — the strings it yields are compared in place, so neither
 *  doc is flattened. `Text.iter` yields one line string (or one `"\n"` break)
 *  per step — NOT a whole `TextLeaf` block — so a "chunk" here is a single line.
 *  Both operands are LF-internal (splitToCmText), so those line strings plus the
 *  `"\n"` breaks concatenate to exactly `toString()`; comparing the chunk
 *  streams is therefore identical to comparing the full strings. `pa`/`pb` track
 *  each side independently because a length-changed line leaves one cursor
 *  mid-line while the other has already exhausted its line. For `dir` -1 the
 *  iterator yields the lines from last to first with each string in normal
 *  order, so each is compared from its own trailing edge. */
function commonRunLength(a: Text, b: Text, max: number, dir: 1 | -1): number {
  const ia = a.iter(dir);
  const ib = b.iter(dir);
  let sa = "";
  let sb = "";
  let pa = 0; // code units already consumed from `sa`'s scan edge
  let pb = 0;
  let matched = 0;
  while (matched < max) {
    if (pa >= sa.length) {
      if (ia.next().done) {
        break;
      }
      sa = ia.value;
      pa = 0;
      continue;
    }
    if (pb >= sb.length) {
      if (ib.next().done) {
        break;
      }
      sb = ib.value;
      pb = 0;
      continue;
    }
    const n = Math.min(sa.length - pa, sb.length - pb, max - matched);
    let k = 0;
    if (dir > 0) {
      while (k < n && sa.charCodeAt(pa + k) === sb.charCodeAt(pb + k)) {
        k++;
      }
    } else {
      while (
        k < n &&
        sa.charCodeAt(sa.length - 1 - pa - k) === sb.charCodeAt(sb.length - 1 - pb - k)
      ) {
        k++;
      }
    }
    matched += k;
    pa += k;
    pb += k;
    if (k < n) {
      break; // mismatch inside the overlap — done
    }
  }
  return matched;
}
