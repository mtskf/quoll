// The table spec of the structural block contract (../structural-blocks.ts): every GFM
// `Table` node that `parseTable` accepts renders as a non-editable block widget. Range
// ownership, the changed-range-bounded update, the full-rebuild reasons, failure → raw
// source and line-level reveal all live in the contract module; this file says only what a
// table block is and which widget shows it.
//
// A block is the node's whole-line range (`block: true` widgets must cover complete lines;
// Lezer's Table range usually IS line-aligned, but doc-final-no-newline edges may not be),
// plus a POSITION-FREE payload carrying everything the widget needs, stored as offsets from
// the block start so a shifted block keeps the same payload object: `nodeOffset` (the Lezer
// node start, the base for per-cell offsets), the per-node LF source slice (the widget's
// eq() key) and the parse. A `Table` node
// `parseTable` rejects — a blockquote-nested table whose continuation lines carry `>`
// markers, or a cell-count mismatch — yields no block and stays raw source.
//
// Per-table sourcing: each table is parsed from `state.sliceDoc(node.from, node.to)`, never
// `state.doc.toString()` — per-node slicing is O(table-bytes), the doc-wide string is
// O(doc-bytes) per rebuild. Cell `from`/`to` in the parsed model are slice-relative; the
// widget adds `nodeFrom` to stamp absolute `data-cell-from` offsets for click-to-reveal.

import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { parseTable, type Table } from "../../../markdown/table/index.js";
import { type BuiltBlock, structuralBlockWidgets } from "../structural-blocks.js";
import { TableBlockWidget } from "./table-widget.js";

export interface TableBlock {
  /** Lezer `Table` node start minus the block start — the widget's `nodeFrom` is
   *  `from + nodeOffset`. */
  readonly nodeOffset: number;
  /** Per-node source slice: the widget's eq() key and the input `table` was parsed from.
   *  LF-only, because the CM document itself is: `cm/seed.ts`'s `splitToCmText` owns that
   *  invariant at the one seam where host bytes become CM text, so no cell `raw` string
   *  carries a `\r` the DOM textNode would render as stray whitespace. */
  readonly slice: string;
  readonly table: Table;
}

function buildTableBlock(state: EditorState, node: SyntaxNodeRef): BuiltBlock<TableBlock> | null {
  // The `\r\n?` replace matches nothing today (see `slice` above); it is a belt-and-braces
  // normaliser, not a sign that the source doc carries CRLF.
  const slice = state.sliceDoc(node.from, node.to).replace(/\r\n?/g, "\n");
  const table = parseTable(slice, 0, slice.length);
  if (table === null) {
    return null;
  }
  const from = state.doc.lineAt(node.from).from;
  const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to;
  return { from, to, block: { nodeOffset: node.from - from, slice, table } };
}

export const tableBlockField = structuralBlockWidgets<TableBlock>({
  name: "table",
  node: "Table",
  build: buildTableBlock,
  // `from` (block line-start) is docFrom; `from + nodeOffset` (Lezer node start) is
  // nodeFrom, the base for per-cell offsets. All LF-internal.
  widget: (b, from) => new TableBlockWidget(b.table, b.slice, from, from + b.nodeOffset),
});
