// Nominal (branded) types for the fenced-code widget/geometry layer, with their
// SINGLE constructors. Two invariants that were previously re-derived (a
// `node.name === "FencedCode"` guard) or merely trusted (a bare `number` used as
// an anchor) at each call site are now encoded in the type system, so a caller
// that mis-anchors a widget or hands over an unrelated node fails to COMPILE:
//
//   - FencedCodeNode — a SyntaxNode PROVEN to be a `FencedCode` node. The one
//     `node.name === "FencedCode"` check lives in asFencedCodeNode; every consumer
//     that needs a FencedCode-typed node routes through it, so no consumer can be
//     handed an arbitrary node.
//   - OpenLineOffset — the document offset of a fenced block's OPEN LINE START
//     (doc.lineAt(node.from).from — NOT node.from, which sits AFTER any indent or
//     `> `/list prefix). The widget eq/anchor key. Constructed only via
//     openLineOffsetOf, so `new CopyButtonWidget(node.from, …)` (a raw node offset,
//     or a `node.to`) can no longer be passed where an open-line anchor is expected.
//
// `@lezer/common` is a direct dep as of PR #66, but SyntaxNode / SyntaxNodeRef are
// derived from syntaxTree's return type rather than imported, to keep the direct-
// dep import surface narrow (same idiom as decorations/types.ts, fenced-code-body.ts).

import type { syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];
// The cursor ref passed to a tree.iterate `enter` callback — a lighter handle than
// a materialised SyntaxNode (name/from/to without allocating the node). A
// SyntaxNode IS a SyntaxNodeRef (its `.node` getter returns itself), so
// asFencedCodeNode accepts both an iterate ref and an already-materialised node.
type SyntaxNodeRef = Parameters<NonNullable<Parameters<Tree["iterate"]>[0]["enter"]>>[0];

declare const fencedCodeNodeBrand: unique symbol;
/** A SyntaxNode proven (via {@link asFencedCodeNode}) to be a `FencedCode` node. */
export type FencedCodeNode = SyntaxNode & { readonly [fencedCodeNodeBrand]: true };

declare const openLineOffsetBrand: unique symbol;
/** The document offset of a fenced block's OPEN LINE START (via
 *  {@link openLineOffsetOf}) — the widget eq/anchor key, distinct at compile time
 *  from a bare `node.from`/`node.to`. */
export type OpenLineOffset = number & { readonly [openLineOffsetBrand]: true };

/** Narrow `node` to a {@link FencedCodeNode}, or null when it is not a FencedCode
 *  node. THE single `node.name === "FencedCode"` gate — every consumer that needs
 *  a FencedCode-typed node routes through here. Accepts an iterate ref so the
 *  cheap name check runs before `.node` is materialised (materialised only on a
 *  match, so a full-tree walk allocates a node only for actual fences). */
export function asFencedCodeNode(node: SyntaxNodeRef): FencedCodeNode | null {
  return node.name === "FencedCode" ? (node.node as FencedCodeNode) : null;
}

/** The OPEN LINE START offset of `node` — the fence-reveal / widget anchor
 *  (doc.lineAt(node.from).from, BEFORE any indent or `> `/list prefix, so a
 *  side:-1 widget renders at the panel row's true start). THE single constructor
 *  of an {@link OpenLineOffset}. */
export function openLineOffsetOf(doc: Text, node: FencedCodeNode): OpenLineOffset {
  return doc.lineAt(node.from).from as OpenLineOffset;
}
