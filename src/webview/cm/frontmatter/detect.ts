// Line-native detection of a file-leading YAML frontmatter fence, directly on
// the CodeMirror document. NOT a Lezer-tree walk (frontmatter is not a
// CommonMark construct and lang-markdown has no Frontmatter node) and NOT a
// whole-document `toString()` (that is O(doc) per keystroke). We scan the line
// model: line 1 must be a fence (O(1) reject for the overwhelmingly common
// non-frontmatter doc); otherwise we look for the first subsequent fence line,
// stopping at the closer. Sharing the single FENCE_LINE predicate with the host
// write-gate keeps "what counts as a fence" in one place.
//
// CRLF: CodeMirror's internal line model strips `\r` (production seeds via
// Text.of(raw.split(/\r\n?|\n/))), so `line(n).text` never carries a `\r`, and
// `doc.sliceString(...)` joins with LF regardless of the lineSeparator facet.
// The detector therefore yields an LF `body` and CodeMirror positions on both
// LF and CRLF documents.

import type { EditorState } from "@codemirror/state";

import { FENCE_LINE } from "../../../markdown/frontmatter.js";

export interface FrontmatterSpan {
  /** Always 0 — frontmatter is file-leading. */
  readonly from: number;
  /** Closer line's exclusive content end (`doc.line(n).to`; excludes the
   *  closer's trailing newline). A CodeMirror position. */
  readonly to: number;
  /** LF-joined body text between the fences (`""` for an empty body). */
  readonly body: string;
  /** Rendered source `[0, to]` — the widget `eq()` key. */
  readonly slice: string;
}

// Per-EditorState memoization. The frontmatter field and the two block-field
// guards each call this on the SAME EditorState instance within one
// transaction; without a cache a `---`-leading no-closer doc would line-scan up
// to three times per docChanged. A WeakMap keyed on the immutable, per-
// transaction EditorState computes once and is GC'd with the state — no shared
// StateField, so no extension-ordering dependency and no loss of the standalone
// table/image test isolation a shared field would cost. `undefined` = not
// cached; a cached `null` (a real "no frontmatter" result) is returned.
const spanCache = new WeakMap<EditorState, FrontmatterSpan | null>();

export function detectLeadingFrontmatterInState(state: EditorState): FrontmatterSpan | null {
  const cached = spanCache.get(state);
  if (cached !== undefined) {
    return cached;
  }
  const span = computeSpan(state);
  spanCache.set(state, span);
  return span;
}

function computeSpan(state: EditorState): FrontmatterSpan | null {
  const doc = state.doc;
  // Need an opener line and at least a closer line below it.
  if (doc.lines < 2) {
    return null;
  }
  // O(1) fast reject: line 1 must be a fence (also the opener check — the
  // write-gate's opener is a fence line followed by a newline, guaranteed here
  // by `doc.lines >= 2`). CodeMirror line text carries no `\r`.
  if (!FENCE_LINE.test(doc.line(1).text)) {
    return null;
  }
  for (let n = 2; n <= doc.lines; n++) {
    if (!FENCE_LINE.test(doc.line(n).text)) {
      continue;
    }
    // First closer found at line n.
    const to = doc.line(n).to;
    const hasBody = n > 2;
    const body = hasBody ? doc.sliceString(doc.line(2).from, doc.line(n - 1).to) : "";
    return { from: 0, to, body, slice: state.sliceDoc(0, to) };
  }
  return null; // no closer → not frontmatter
}

/** The end position of a leading frontmatter span, or 0 when absent. Consumed
 *  by the table/image block-field guards to exclude their nodes. */
export function leadingFrontmatterEnd(state: EditorState): number {
  const span = detectLeadingFrontmatterInState(state);
  return span ? span.to : 0;
}
