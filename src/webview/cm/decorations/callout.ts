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

// `@lezer/common` is a direct dep as of PR #66 (for the lint incremental
// parser's `TreeFragment`); derive SyntaxNode from syntaxTree's return type
// rather than importing it to avoid widening the direct-dep import surface —
// the same strategy as fenced-code-body.ts / types.ts / block-style.ts.
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

/** The `[!TYPE]` admonition token itself (case-insensitive), matched AFTER the
 *  CommonMark quote prefix and content indent have been stripped by
 *  `calloutTypeForLine`. Allows an OPTIONAL Obsidian fold suffix (`-`/`+`) and
 *  requires the closing `]` to be followed by whitespace or end-of-line — so bare
 *  `[!NOTE]` (GitHub), `[!NOTE] title` and `[!NOTE]-` (Obsidian) all match while
 *  `[!NOTEX]` / `[!FOO]` / `[!NOTE]x` do not. */
const CALLOUT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\](?:[-+])?(?=\s|$)/i;

/** The number of `>` quote levels a line opens with, or 0 when it does not open a
 *  blockquote. The prefix is up to 3 spaces of initial indent (`^ {0,3}`; 4+ is a
 *  top-level indented code block, never a blockquote) then one or more `>`, each
 *  consuming ONE optional *literal* space as its delimiter (`(?:> ?)+`). Returned
 *  with the matched length so the caller can continue the column count. */
const CALLOUT_QUOTE_PREFIX_RE = /^ {0,3}(?:> ?)+/;

/** The callout type of a blockquote first line, or null when the line is not a
 *  recognised `[!TYPE]` marker (→ generic Phase-1 panel; the structural
 *  unknown-`[!FOO]` fallback).
 *
 *  Strips the CommonMark quote prefix the way Lezer parses it, so classification
 *  and the rendered tree can never disagree:
 *   1. the `>` quote prefix (`CALLOUT_QUOTE_PREFIX_RE`) — a `>` marker consumes at
 *      most ONE *literal* space as its delimiter; a TAB is never the delimiter;
 *   2. the remaining content indent, measured in COLUMNS with tabs expanded to
 *      CommonMark's 4-column tab stops. 4+ columns is an indented code block, so
 *      the `[!TYPE]` inside it is code, not a marker.
 *
 *  Measuring the indent in columns (rather than expanding tabs to spaces first,
 *  which would let the `>` delimiter eat into a tab it does not own) is why a lone
 *  `>\t[!NOTE]` is a callout — a 3-column indent → a Paragraph — while `>\t\t…`
 *  (6 columns) and `   >\t…` (a tab from column 4 → 8 = 4 columns) are indented
 *  CodeBlocks and are NOT, each verified against Lezer. Pure — the sole input is
 *  the first line's text. */
export function calloutTypeForLine(lineText: string): CalloutType | null {
  const prefix = CALLOUT_QUOTE_PREFIX_RE.exec(lineText);
  if (prefix === null) {
    return null;
  }
  // The prefix is spaces and `>` only, so its char length equals its column
  // width; continue the absolute column count from there across the indent.
  const indentStart = prefix[0].length;
  let column = indentStart;
  let i = indentStart;
  for (; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === " ") {
      column += 1;
    } else if (ch === "\t") {
      column += 4 - (column % 4);
    } else {
      break;
    }
  }
  if (column - indentStart >= 4) {
    return null; // indented code block, not a marker
  }
  const m = CALLOUT_MARKER_RE.exec(lineText.slice(i));
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
