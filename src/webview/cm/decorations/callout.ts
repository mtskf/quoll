// Pure callout knowledge — the `[!TYPE]` admonition grammar PLUS the marker-row
// conceal geometry, with NO @codemirror/view imports (mirrors fenced-code-body.ts).
// Both block-style.ts (per-line classes + the `-open` corner migration) and
// callout-marker-conceal.ts (the StateField that conceals the marker row) import
// from here; leaving the classification in block-style.ts would force a circular
// import once block-style depends on the conceal predicate — so this is the single
// source of truth both consumers call, and they can never disagree.

import type { syntaxTree } from "@codemirror/language";
import type { EditorSelection, Text } from "@codemirror/state";

import { intersectsAnySelection } from "./shared.js";

// `@lezer/common` is a transitive-only dep pnpm does not hoist (supply-chain
// default-deny) — derive SyntaxNode from syntaxTree's return type, the same
// strategy as fenced-code-body.ts / types.ts / block-style.ts.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** Base class on EVERY line of a recognised callout blockquote (a Blockquote
 *  whose first line is a `[!TYPE]` admonition marker). It is the theme hook for
 *  the shared accent border + tint (cm/theme.ts `.cm-line.quoll-callout`), paired
 *  with the per-type `calloutClassForType` class that supplies the accent value. */
export const CALLOUT_CLASS = "quoll-callout";

/** Class on the FIRST line of a callout (the `[!TYPE]` marker line) when it is
 *  REVEALED (caret inside the block). Drives the header font-weight in cm/theme.ts.
 *  When the marker row is CONCEALED it is skipped by block-style and this class is
 *  not emitted — the StateField's zero-height class takes over. */
export const CALLOUT_MARKER_CLASS = "quoll-callout-marker";

/** Class on a CONCEALED marker line (caret OUTSIDE the callout block). Emitted by
 *  the callout-marker-conceal StateField, which replaces the whole marker row and
 *  collapses it to zero height via this class — the theme copies the five
 *  zero-height props of `.quoll-fenced-code-fence-hidden`. */
export const CALLOUT_MARKER_HIDDEN_CLASS = "quoll-callout-marker-hidden";

/** The five GitHub/Obsidian admonition types. A `[!TYPE]` first line inside a
 *  blockquote selects a per-type accent colour + icon; any other bracket token
 *  is NOT a callout and the block stays the generic Phase-1 panel. */
export type CalloutType = "note" | "tip" | "important" | "warning" | "caution";

/** Per-type theme hook class (`quoll-callout-note` … `-caution`). */
export function calloutClassForType(type: CalloutType): string {
  return `${CALLOUT_CLASS}-${type}`;
}

/** Admonition marker matcher. Strips the CommonMark quote prefix — up to 3
 *  leading spaces (`^ {0,3}`; 4+ is an indented code block), one-or-more `>`
 *  levels each with an optional single marker space (`(?:> ?)+`), then up to 3
 *  content-indent spaces (` {0,3}`) — and matches `[!TYPE]` case-insensitively,
 *  allowing an OPTIONAL Obsidian fold suffix (`-`/`+`) and requiring the closing
 *  token to be followed by whitespace or end-of-line. So bare `[!NOTE]` (GitHub),
 *  `[!NOTE] title` and `[!NOTE]-` (Obsidian) all match while `[!NOTEX]` /
 *  `[!FOO]` / `[!NOTE]x` do not. The whitespace is CAPPED (not the earlier greedy
 *  `\s*`) so a `>     [!NOTE]` — where 4+ spaces after the `>` marker make the
 *  content an indented CODE BLOCK in CommonMark (verified against Lezer:
 *  Blockquote > CodeBlock at ≥5 spaces after a single `>`) — is NOT mistaken for a
 *  callout. A Blockquote's first line always carries a leading `>`, so the prefix
 *  strip always fires. Pure — the sole input is the first line's text. */
const CALLOUT_MARKER_RE =
  /^ {0,3}(?:> ?)+ {0,3}\[!(note|tip|important|warning|caution)\](?:[-+])?(?=\s|$)/i;

/** The callout type of a blockquote first line, or null when the line is not a
 *  recognised `[!TYPE]` marker (→ generic Phase-1 panel; the structural
 *  unknown-`[!FOO]` fallback). */
export function calloutTypeForLine(lineText: string): CalloutType | null {
  const m = CALLOUT_MARKER_RE.exec(lineText);
  return m === null ? null : (m[1].toLowerCase() as CalloutType);
}

/** True when `node` sits inside another Blockquote (a nested `> >` inner node).
 *  Callout classification is scoped to the OUTERMOST quote so a line never
 *  receives two conflicting `quoll-callout-{type}` classes — the container's
 *  type wins by construction, not by CSS source-order accident. */
function hasBlockquoteAncestor(node: SyntaxNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.name === "Blockquote") {
      return true;
    }
  }
  return false;
}

/** The callout type of the OUTERMOST blockquote `node`, or null when `node` is a
 *  nested inner quote (a `> >` child — the container's type wins) OR its first
 *  line is not a recognised `[!TYPE]` marker. The single classification entry both
 *  block-style.ts and the conceal StateField call. */
export function calloutTypeForOutermost(doc: Text, node: SyntaxNode): CalloutType | null {
  return hasBlockquoteAncestor(node) ? null : calloutTypeForLine(doc.lineAt(node.from).text);
}

/** True when any selection range intersects the callout `node`'s FULL line span —
 *  the BLOCK-SCOPED reveal predicate (parity with fencedCodeBlockRevealed). A caret
 *  ANYWHERE in the block (the marker row OR any body line) reveals the editable
 *  `[!TYPE]` source; leaving the block conceals it. `node.to - 1` resolves the last
 *  CONTENT line even if a future Lezer overshoots node.to onto a trailing line
 *  (quoll-lezer-table-to-overshoots-trailing-line); boundary-inclusive via
 *  intersectsAnySelection. */
export function calloutBlockRevealed(
  doc: Text,
  selection: EditorSelection,
  node: SyntaxNode
): boolean {
  return intersectsAnySelection(selection, doc.lineAt(node.from).from, doc.lineAt(node.to - 1).to);
}

/** The marker line span `{from, to}` to CONCEAL for callout `node`, or null when
 *  the marker row must stay visible. null when: `node` is not an outermost callout
 *  (calloutTypeForOutermost null); OR the callout is marker-ONLY (no body line —
 *  concealing it would vanish the whole block, since the marker is the sole row);
 *  OR the block is revealed (a selection intersects it). Otherwise the first line's
 *  span. The SINGLE source of truth both block-style.ts and the StateField call so
 *  the `-open` corner migration and the conceal can never disagree. */
export function calloutMarkerConceal(
  doc: Text,
  selection: EditorSelection,
  node: SyntaxNode
): { from: number; to: number } | null {
  if (calloutTypeForOutermost(doc, node) === null) {
    return null;
  }
  const firstLine = doc.lineAt(node.from);
  const lastLine = doc.lineAt(node.to - 1);
  if (lastLine.number === firstLine.number) {
    return null; // marker-only callout: NEVER conceal a bodyless callout
  }
  if (calloutBlockRevealed(doc, selection, node)) {
    return null;
  }
  return { from: firstLine.from, to: firstLine.to };
}
