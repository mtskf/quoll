// src/markdown/table/model.ts
// Source-span-mapped GFM table model consumed by parse.ts / serialize.ts.
// Spans are absolute document offsets (UTF-16 code units — same units
// as JavaScript string.length and CodeMirror dispatch({from,to})) so a
// downstream consumer (C6c editable cells) can splice a single cell
// with a precise view.dispatch({ changes: { from, to, insert } }).

export type Align = "left" | "center" | "right" | null;

/** Line terminator preserved on each row. `""` only on a slice's final row. */
export type LineEnding = "" | "\n" | "\r\n";

/**
 * The escaped-Markdown brand for a content cell's `raw`. A `CellRaw` is a
 * `string` whose `|` and `\` are guaranteed escaped, so a downstream consumer
 * can write it between pipes without corrupting column structure. The brand
 * makes that a COMPILE-TIME invariant: a `CellRaw` is obtained only via an
 * `as CellRaw` cast — used by parse sites for an already-escaped verbatim
 * source slice (the [cellStart, cellEnd) scan never encloses an unescaped `|`).
 */
export type CellRaw = string & { readonly __cellRaw: unique symbol };

/**
 * A content cell. `raw` is verbatim escaped Markdown (escaped pipes stay as
 * `\|`), branded {@link CellRaw} so an unescaped `|` cannot be written into it
 * without an explicit cast.
 */
export interface Cell {
  readonly raw: CellRaw;
  leadingSpace: string;
  trailingSpace: string;
  from: number;
  to: number;
}

export interface Row {
  cells: Cell[];
  leadingPipe: boolean;
  trailingPipe: boolean;
  /** Verbatim leading whitespace before the row's first pipe/content. Non-empty
   *  only for indented rows — e.g. a table nested in a list item, where Lezer
   *  keeps the continuation lines' indent in the Table node slice. Serialized
   *  verbatim so the row round-trips byte-for-byte. */
  leadingIndent: string;
  /** Verbatim whitespace from the row body end to the line's terminator. Preserves trailing spaces after a final `|`. */
  trailingLineSpace: string;
  /** The line terminator that followed this row in source: "\n", "\r\n", or "" for the table's last row. CRLF MUST round-trip verbatim. */
  lineEnding: LineEnding;
  from: number;
  to: number;
}

export interface DelimiterCell {
  raw: string;
}

export interface DelimiterRow {
  cells: DelimiterCell[];
  leadingPipe: boolean;
  trailingPipe: boolean;
  /** See {@link Row.leadingIndent}. */
  leadingIndent: string;
  trailingLineSpace: string;
  lineEnding: LineEnding;
  from: number;
  to: number;
}

/**
 * Header and delimiter rows MUST carry equal cell counts. That invariant is
 * enforced at construction by {@link makeTable} — the sanctioned way to build
 * a `Table`, which throws on a mismatch. On parse input a mismatch is not an
 * error but a non-table: `parseTable` pre-checks and returns null per GFM/Lezer
 * before reaching the factory, so the throw backstops the structure column ops
 * (and future logic errors), not parse input.
 *
 * Body rows MAY differ in cell count from `delimiter.cells.length`: the parser
 * does not pad/truncate and `makeTable` does not constrain them.
 */
export interface Table {
  header: Row;
  delimiter: DelimiterRow;
  rows: Row[];
  from: number;
  to: number;
}

/**
 * Construct a {@link Table}, enforcing the GFM rule that the header and
 * delimiter rows carry the SAME number of cells. `Table` is a plain interface,
 * so TypeScript cannot express this invariant: any spread-and-mutate build
 * could silently set `header.cells.length !== delimiter.cells.length`, yielding
 * a table whose `tableAlign[col]` is `undefined` and whose columns misalign at
 * render. Routing every `Table` construction through this factory makes that
 * latent corruption a loud build-time throw: the structure column ops rely on it
 * directly, while `parseTable` pre-screens mismatches as non-tables (returns
 * null) before constructing, so there the throw is a redundant backstop.
 *
 * Body `rows` are intentionally unconstrained: GFM/Lezer never pads or truncates
 * ragged body rows, so neither does this factory (see {@link Table}).
 */
export function makeTable(
  header: Row,
  delimiter: DelimiterRow,
  rows: Row[],
  from: number,
  to: number
): Table {
  if (header.cells.length !== delimiter.cells.length) {
    throw new Error(
      `Table header/delimiter cell-count mismatch: header has ${header.cells.length}, delimiter has ${delimiter.cells.length}`
    );
  }
  return { header, delimiter, rows, from, to };
}

/** A trimmed GFM delimiter marker, capturing the optional leading/trailing
 *  alignment colons (`:---:` → both, `:---` → left, `---:` → right). */
const ALIGN_MARKER = /^(:?)-+(:?)$/;

/**
 * Interpret a delimiter cell's verbatim marker as its column alignment, or
 * `undefined` when `raw` is not a valid GFM delimiter marker. `raw` may carry
 * surrounding padding (e.g. `" :---: "`) — it is trimmed first.
 *
 * This is the ONE place a marker is interpreted: `parseTable`'s validity check
 * and `tableAlign`'s projection both route through it, so a delimiter cell's
 * `raw` is the single source of truth for alignment — there is no separate
 * stored `align` that could drift from the verbatim marker.
 */
export function alignFromRaw(raw: string): Align | undefined {
  const m = ALIGN_MARKER.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const left = m[1] === ":";
  const right = m[2] === ":";
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

/**
 * Column alignments, projected on demand from each delimiter cell's `raw`
 * marker via {@link alignFromRaw}. The projection reads the verbatim `raw`, so
 * it can never disagree with the source markers — and there is no cached array
 * to fall stale.
 *
 * A cell whose `raw` is not a valid marker yields `undefined`, NOT a coerced
 * `null`: collapsing it would let an invalid marker masquerade as the explicit
 * GFM default and hide the very divergence this projection exists to prevent.
 * A parsed `Table` never contains such a cell (parseTable rejects them); the
 * partiality only covers hand-built tables.
 */
export function tableAlign(table: Table): readonly (Align | undefined)[] {
  return table.delimiter.cells.map((c) => alignFromRaw(c.raw));
}
