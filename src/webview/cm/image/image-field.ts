// StateField that renders every STANDALONE Markdown image (an inline `Image`
// node that is the sole content of its parent Paragraph and line) as a non-
// editable block widget, and publishes the widget's range to the
// quollBlockReplaceZones facet so C4a's inline-reveal orchestrator drops marks
// inside the widget and blockZoneArrowKeymap navigates across it.
//
// Block widgets MUST be sourced from a StateField, not a ViewPlugin —
// CodeMirror throws if a ViewPlugin emits a `block: true` Decoration.replace.
//
// Eligibility (explicit; CommonMark images are INLINE — they live inside a
// Paragraph):
//   1. inline form only: a `URL` child means `![alt](url)`. Reference images
//      `![a][ref]` and empty-destination `![a]()` have no URL child → skipped
//      (left as raw source; the write-gate gates reference definitions where
//      they live).
//   2. parent is a Paragraph whose entire trimmed content equals the image —
//      excludes inline images amid prose and soft-break siblings sharing the
//      paragraph (promoting one line of a multi-line paragraph would split it).
//   3. the image's line(s) trimmed equal the image — excludes blockquote
//      `> ![…]` and list `- ![…]`, whose paragraph text equals the image but
//      whose LINE carries a prefix marker that a whole-line block-replace would
//      wrongly swallow.
//
// Render-gate (fail-closed): the URL is the Lezer `URL` child — the SAME node
// lezer-url-walker (the write-gate) gates — decoded + allowlist-gated via the
// SHARED `renderSafeMarkdownDestination` (the one render-side decode→gate choke
// point, also used by the table-cell renderer cm/table/cell-render.ts, so the
// two render gates cannot drift). Passing a raw slice straight to the allowlist
// would fail open on angle-bracket / backslash / char-ref forms. Any throw in
// decode/gate is caught and treated as blocked (safeUrl = null), mirroring the
// defense-in-depth catch in validate-for-write.ts. The verdict (AllowlistedUrl
// | null) is handed to the widget, which never re-gates.
//
// Alt is the CommonMark-normalized image label: the raw chars between `![` and
// the label-closing `]` are run through `commonMarkAltText` (backslash/entity
// decode + emphasis flatten) so `<img alt>` and the blocked placeholder's
// `aria-label` carry the rendered text, not the raw markup.
//
// Recompute + reveal strategy: the widget DecorationSet is rebuilt
// changed-range-bounded, NOT by a full-document syntax-tree walk per keystroke.
// On a docChanged (or span-changing selection-only) transaction we reuse the
// previously-built widgets OUTSIDE an `extendedSpan` and re-walk the tree only
// INSIDE it (`buildRange`). The measured cost of the old full `iterate` was
// whole-tree materialisation over the changed-into-fresh post-edit tree (~5 ms
// per keystroke at 1 MB), NOT node count — so a bounded `{from,to}` iterate
// (≈0 ms added) is the fix; a "skip-Paragraph / cheaper full walk" was measured
// and REJECTED (the cost is materialisation, not descent). Soundness rests on
// `extendedSpan` covering every line whose widget eligibility can change:
//   G1 — each changed range is expanded by ±1 line, because a blank-line toggle
//        ADJACENT to an image re-groups its parent Paragraph and flips its
//        standalone eligibility WITHOUT touching the image's own bytes.
//   G2 — if the post-edit parser frontier is incomplete
//        (`!syntaxTreeAvailable`), a docChanged transaction can reveal nodes
//        outside the changed range, so fall back to a full recompute (the later
//        background-parse publication self-heals via the tree-identity branch).
//   G3 — a change to `leadingFrontmatterEnd` flips the `from < fmEnd` gate for
//        images near the top → full recompute.
// A reused widget whose document position SHIFTED is reconstructed with the new
// docFrom (cheap: same alt/safeUrl/slice, NO re-parse). DRY-via-factory with
// tableBlockField (the `defineBlockWidgetField` rule-of-three home) is the
// table follow-up's job — the table field's global ordinal makes bounding it
// harder; see TODO.

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { renderSafeMarkdownDestination } from "../../../markdown/render-safe-markdown-destination.js";
import { type AllowlistedUrl, resolveTrustedResourceUrl } from "../../../markdown/url-allowlist.js";
import { quollBlockReplaceZones } from "../decorations/orchestrator.js";
import { leadingFrontmatterEnd } from "../frontmatter/detect.js";
import { commonMarkAltText } from "../table/cell-render.js";
import { ImageBlockWidget } from "./image-widget.js";
import { quollResourceBaseUri } from "./resource-base.js";

interface BuiltWidget {
  from: number;
  to: number;
  widget: ImageBlockWidget;
  deco: Decoration;
}

interface Interval {
  from: number;
  to: number;
}

// Trim only ASCII *structural* whitespace: space, tab, LF, CR — the set the
// Lezer markdown parser treats as insignificant at a line/paragraph boundary
// (indentation + line endings). It deliberately EXCLUDES U+000B (vertical
// tab), U+000C (form feed), NBSP, and every other Unicode space, which the
// parser keeps as significant paragraph content (Codex probe: a leading VT
// stays inside the Paragraph node) — so a line whose only prefix is one of
// them must NOT be promoted to a standalone image, and a whole-line block-
// replace must not swallow it. `String.prototype.trim()` strips all of them
// and would mis-promote such lines (Codex re-review N1 + N4).
function trimAsciiWs(s: string): string {
  return s.replace(/^[ \t\n\r]+/, "").replace(/[ \t\n\r]+$/, "");
}

function makeWidget(
  alt: string,
  safeUrl: AllowlistedUrl | null,
  imgText: string,
  from: number,
  to: number
): BuiltWidget {
  const widget = new ImageBlockWidget(alt, safeUrl, imgText, from);
  return { from, to, widget, deco: Decoration.replace({ widget, block: true }) };
}

// Diagnostic latch: a relative-resolution failure (a present base plus a
// relative path that won't resolve/trust) is logged ONCE per webview session.
// Without a latch a malformed base would spam a warning for every relative
// image on every document change; one line is enough to triage. The reachable
// case in normal operation is a `../` destination escaping the document
// directory (resolveTrustedResourceUrl's containment check rejects it); the
// breadcrumb tells the author why the 🚫 placeholder rendered.
let warnedUnresolvableImage = false;

/** Resolve a gated image URL against the document's base URI for rendering.
 *  - Absolute URLs (parse standalone — http(s)/mailto) pass through unchanged;
 *    remote http(s) stay CSP-blocked at render (the caller's concern).
 *  - A relative URL is resolved + scheme/authority/containment-checked +
 *    branded by resolveTrustedResourceUrl (scheme-agnostic; survives a VS Code
 *    resource-scheme change — see url-allowlist.ts). We deliberately do NOT
 *    re-run renderSafeUrl on the resolved value (its http/https/mailto
 *    allowlist would reject a non-https resource scheme).
 *  Returns null (→ inert placeholder) for: no base (non-file doc), a
 *  fragment-/query-only destination (resolves to the document FILE itself,
 *  never an image), a `../` destination escaping the document directory, or a
 *  resolve/authority-check failure (logged once). */
function resolveAgainstBase(url: AllowlistedUrl, base: string): AllowlistedUrl | null {
  let isAbsolute = false;
  try {
    new URL(url);
    isAbsolute = true;
  } catch {
    isAbsolute = false;
  }
  if (isAbsolute) {
    return url;
  }
  if (base === "") {
    return null; // non-file document: no folder to resolve against (expected)
  }
  if (url.startsWith("#") || url.startsWith("?")) {
    return null; // fragment-/query-only → the document file, not an image
  }
  const resolved = resolveTrustedResourceUrl(url, base);
  if (resolved === null && !warnedUnresolvableImage) {
    warnedUnresolvableImage = true;
    console.warn("[quoll] relative image could not be resolved against the document base", { url });
  }
  return resolved;
}

/** Build every standalone-image widget whose node OVERLAPS [rangeFrom, rangeTo].
 *  Called with [0, doc.length] for a full recompute and with each bounded
 *  interval otherwise. Pure reader of the lazy syntaxTree. */
function buildRange(state: EditorState, rangeFrom: number, rangeTo: number): BuiltWidget[] {
  const tree = syntaxTree(state);
  const out: BuiltWidget[] = [];
  // The frontmatter block (frontmatterBlockField) owns the outermost block over
  // [0, fmEnd]; never emit a competing block replace inside it.
  const fmEnd = leadingFrontmatterEnd(state);
  const base = state.facet(quollResourceBaseUri);
  tree.iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name !== "Image") {
        return;
      }
      if (node.from < fmEnd) {
        return;
      }
      // (1) inline form only.
      const urlNode = node.node.getChild("URL");
      if (!urlNode) {
        return;
      }
      // (2) parent Paragraph contains ONLY the image.
      const parent = node.node.parent;
      if (!parent || parent.name !== "Paragraph") {
        return;
      }
      const imgText = trimAsciiWs(state.sliceDoc(node.from, node.to));
      if (trimAsciiWs(state.sliceDoc(parent.from, parent.to)) !== imgText) {
        return;
      }
      // (3) the image's line(s) carry no prefix marker beyond the image.
      const startLine = state.doc.lineAt(node.from);
      const endLine = state.doc.lineAt(Math.min(node.to, state.doc.length));
      if (trimAsciiWs(state.sliceDoc(startLine.from, endLine.to)) !== imgText) {
        return;
      }
      const from = startLine.from;
      const to = endLine.to;
      if (from >= to) {
        return;
      }
      // Render-gate, fail-closed. Shared decode→gate choke point with the
      // table-cell renderer (cm/table/cell-render.ts) so the two render gates
      // cannot drift. The catch is defense-in-depth (mirrors validate-for-write).
      let safeUrl: AllowlistedUrl | null;
      try {
        const safe = renderSafeMarkdownDestination(state.sliceDoc(urlNode.from, urlNode.to));
        safeUrl = safe.kind === "safe" ? resolveAgainstBase(safe.url, base) : null;
      } catch {
        safeUrl = null;
      }
      // Alt = raw label source between `![` and the label-closing `]`. The `]`
      // is the last `]` before the `(` that opens the destination — robust to
      // inner paren whitespace `![a]( url )` and to a title `![a](url "t")`.
      const gap = state.sliceDoc(node.from + 2, urlNode.from);
      const parenIdx = gap.lastIndexOf("(");
      const bracketIdx = parenIdx >= 0 ? gap.lastIndexOf("]", parenIdx) : gap.lastIndexOf("]");
      const altRaw = bracketIdx >= 0 ? gap.slice(0, bracketIdx) : "";
      const alt = commonMarkAltText(altRaw);
      out.push(makeWidget(alt, safeUrl, imgText, from, to));
    },
  });
  return out;
}

function lineRangeOverlapsSelection(s: EditorSelection, from: number, to: number): boolean {
  for (const r of s.ranges) {
    if (r.from <= to && from <= r.to) {
      return true;
    }
  }
  return false;
}

function lineExpand(state: EditorState, from: number, to: number): Interval {
  const len = state.doc.length;
  const lo = state.doc.lineAt(Math.max(0, Math.min(from, len)));
  const hi = state.doc.lineAt(Math.max(0, Math.min(to, len)));
  return { from: lo.from, to: hi.to };
}

/** Line-expand AND pull in one neighbour line on each side (G1: a blank-line
 *  toggle adjacent to an image flips its standalone eligibility). */
function lineExpandWithNeighbours(state: EditorState, from: number, to: number): Interval {
  const inner = lineExpand(state, from, to);
  const prevFrom = inner.from > 0 ? state.doc.lineAt(inner.from - 1).from : inner.from;
  const nextTo = inner.to < state.doc.length ? state.doc.lineAt(inner.to + 1).to : inner.to;
  return { from: prevFrom, to: nextTo };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function computeExtendedSpan(tr: Transaction): Interval[] {
  const state = tr.state;
  const raw: Interval[] = [];
  if (tr.docChanged) {
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      raw.push(lineExpandWithNeighbours(state, fromB, toB)); // G1
    });
  }
  for (const r of tr.startState.selection.ranges) {
    const a = tr.changes.mapPos(r.from, 1);
    const b = tr.changes.mapPos(r.to, -1);
    raw.push(lineExpand(state, Math.min(a, b), Math.max(a, b)));
  }
  for (const r of tr.state.selection.ranges) {
    raw.push(lineExpand(state, r.from, r.to));
  }
  return mergeIntervals(raw);
}

function intersectsAny(intervals: Interval[], from: number, to: number): boolean {
  for (const iv of intervals) {
    if (from <= iv.to && iv.from <= to) {
      return true;
    }
  }
  return false;
}

function selectionLineSpansEqual(prevState: EditorState, newState: EditorState): boolean {
  const prev = prevState.selection;
  const curr = newState.selection;
  if (prev.ranges.length !== curr.ranges.length) {
    return false;
  }
  for (let i = 0; i < curr.ranges.length; i++) {
    const a = prev.ranges[i];
    const b = curr.ranges[i];
    if (
      prevState.doc.lineAt(a.from).from !== newState.doc.lineAt(b.from).from ||
      prevState.doc.lineAt(a.to).to !== newState.doc.lineAt(b.to).to
    ) {
      return false;
    }
  }
  return true;
}

function toSet(all: BuiltWidget[], state: EditorState): DecorationSet {
  const visible = all.filter((w) => !lineRangeOverlapsSelection(state.selection, w.from, w.to));
  if (visible.length === 0) {
    return Decoration.none;
  }
  return Decoration.set(visible.map((w) => w.deco.range(w.from, w.to)));
}

function computeFreshFull(state: EditorState): DecorationSet {
  const all = buildRange(state, 0, state.doc.length);
  all.sort((a, b) => a.from - b.from);
  return toSet(all, state);
}

function computeBounded(
  prev: DecorationSet,
  tr: Transaction,
  intervals: Interval[]
): DecorationSet {
  const state = tr.state;
  const byFrom = new Map<number, BuiltWidget>();
  const iter = prev.iter();
  while (iter.value !== null) {
    const widget = iter.value.spec.widget as ImageBlockWidget;
    const touched = tr.changes.touchesRange(iter.from, iter.to) !== false;
    const newFrom = tr.changes.mapPos(iter.from, 1);
    const newTo = tr.changes.mapPos(iter.to, -1);
    if (!touched && !intersectsAny(intervals, newFrom, newTo)) {
      if (newFrom === iter.from && newTo === iter.to) {
        byFrom.set(iter.from, {
          from: iter.from,
          to: iter.to,
          widget,
          deco: iter.value as Decoration,
        });
      } else {
        // Position shift only: alt/safeUrl/slice unchanged, new docFrom. No re-parse.
        const r = makeWidget(widget.alt, widget.safeUrl, widget.slice, newFrom, newTo);
        byFrom.set(r.from, r);
      }
    }
    iter.next();
  }
  for (const ivl of intervals) {
    for (const w of buildRange(state, ivl.from, ivl.to)) {
      byFrom.set(w.from, w); // fresh wins (a node spanning two intervals de-dupes here)
    }
  }
  const all = [...byFrom.values()].sort((a, b) => a.from - b.from);
  return toSet(all, state);
}

function extractRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

export const imageBlockField = StateField.define<DecorationSet>({
  create: (state) => computeFreshFull(state),
  update: (prev, tr) => {
    if (leadingFrontmatterEnd(tr.startState) !== leadingFrontmatterEnd(tr.state)) {
      return computeFreshFull(tr.state); // G3
    }
    if (tr.docChanged) {
      if (!syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
        return computeFreshFull(tr.state); // G2: frontier incomplete
      }
      return computeBounded(prev, tr, computeExtendedSpan(tr));
    }
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return computeFreshFull(tr.state); // background-parse publication
    }
    if (selectionLineSpansEqual(tr.startState, tr.state)) {
      return prev;
    }
    return computeBounded(prev, tr, computeExtendedSpan(tr));
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    quollBlockReplaceZones.from(f, (set) => extractRanges(set)),
  ],
});
