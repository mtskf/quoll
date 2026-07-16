// Pure converter: an HTML `text/html` clipboard fragment containing a `<table>`
// → an equivalent GFM Markdown table string, or `null` when there is nothing
// convertible (the caller then falls back to normal paste). No dependency, no
// side effects — `DOMParser` is a webview/browser global (happy-dom provides it
// under test), so this stays inside Quoll's supply-chain default-deny.
//
// Design notes (why each choice, so a future edit doesn't regress it):
//  - Structure is read via an EXPLICIT direct-child walk, NOT the
//    `HTMLTableElement.rows` / `HTMLTableRowElement.cells` collections: happy-dom
//    leaks NESTED-table rows/cells through those (verified), which would make the
//    nested-table contract untestable. Walking only the table's direct `<tr>` (and
//    the direct `<tr>` of its `<thead>`/`<tbody>`/`<tfoot>`) excludes nested tables
//    in both happy-dom and real browsers, and handles the browser-implicit
//    `<tbody>` wrap.
//  - colspan/rowspan are spread through an OCCUPANCY GRID (the standard HTML table
//    algorithm): content anchors top-left, the spanned region fills with empty
//    cells (GFM cannot merge). A naive rowspan-ignore would shift lower rows LEFT
//    into the wrong columns — this keeps columns aligned. Always rectangular.
//  - Cell text neutralises Markdown-inline-active characters (escapeCell) so a
//    pasted cell round-trips as LITERAL text and cannot re-activate as an explicit
//    Markdown link/image/code/emphasis. This — not the host write-gate — is the
//    primary safety property. (A bare GFM autolink `http(s)://` / `www.` / email
//    may still render live, but those are exactly the allowlist-safe schemes,
//    gated identically to the same text typed in; `javascript:` is never
//    bare-autolinked by GFM, so no unsafe URL can form.)

// Bound conversion cost against a hostile / pathological clipboard. A breach of
// any cap degrades to `null` (normal paste, itself bounded by the edit layer's
// MAX_CONTENT_LENGTH gate) — never a thrown handler.
const MAX_HTML_TABLE_INPUT_CHARS = 2 * 1024 * 1024; // 2 MiB of source HTML
const MAX_HTML_TABLE_ROWS = 5_000;
const MAX_HTML_TABLE_COLS = 1_000;
const MAX_HTML_TABLE_CELLS = 50_000;
const MAX_COLSPAN = 1_000;
const MAX_ROWSPAN = 1_000;

// DOM node types (numeric literals so we never depend on a `Node` global binding).
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Elements whose text must NOT enter a cell. `DOMParser` never executes these
// (no script runs), but their raw source would otherwise pollute the cell.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);

// Block-level elements: their children are bracketed with spaces so text across a
// boundary does not glue (`<div>a</div><div>b</div>` → `a b`, not `ab`). Unknown
// elements recurse as inline — an acceptable degrade (surplus whitespace collapses).
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "TR",
  "TD",
  "TH",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "SECTION",
  "ARTICLE",
  "HR",
  "PRE",
  "FIGURE",
]);

/** Clamp a DOM col/row span into `[1, max]`. `colspan="0"`/`rowspan="0"` (the DOM
 *  may report `0`) → `1`: v1 does NOT implement HTML's span-to-end-of-section.
 *  Non-finite / <1 also normalise to 1. */
function clampSpan(n: number, max: number): number {
  if (!Number.isFinite(n) || n < 1) {
    return 1;
  }
  return Math.min(Math.floor(n), max);
}

/** `true` when `el` has an ancestor `<table>` (i.e. it is a nested table, not a
 *  top-level one). Walks `parentElement` rather than `closest("table")` because
 *  `el` itself IS a table and `closest` would match it. */
function hasAncestorTable(el: Element): boolean {
  let p = el.parentElement;
  while (p) {
    if (p.tagName === "TABLE") {
      return true;
    }
    p = p.parentElement;
  }
  return false;
}

/** `true` when the document carries meaningful (non-whitespace) text OUTSIDE the
 *  given table's subtree — prose alongside the table. Iterative pre-order DFS
 *  (same explicit-stack style as `collectCellText`) over `<body>`, skipping the
 *  table's own subtree and `SKIP_TAGS` (whose text never belongs in a cell and
 *  is likewise not "prose"). `<meta>`/comments contribute no text node, so a
 *  normal single-table clipboard copy — which the browser wraps in
 *  `<meta>`/`<style>` — is NOT flagged.
 *
 *  Scope is deliberately TEXT-only (Codex review): a text-less sibling element
 *  (`<img>`, `<hr>`, media, form controls) does NOT flag the fragment. Deferring
 *  on those would be strictly worse — plain-text paste (the fallback) preserves
 *  none of them either, and it would additionally lose the table's structure by
 *  pasting tab-separated text. Text is exactly the content the fallback DOES
 *  preserve, so it is the correct boundary for "defer instead of convert". (A
 *  clipboard that carries a real image FILE alongside a table is a separate,
 *  deliberate arbitration: the Prec.high table handler wins — see html-table-paste.ts.) */
function hasTextOutsideTable(body: Element, table: Element): boolean {
  const stack: Node[] = [];
  const seed = body.childNodes;
  for (let i = seed.length - 1; i >= 0; i--) {
    stack.push(seed[i]);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node === table) {
      continue; // skip the chosen table's entire subtree
    }
    if (node.nodeType === TEXT_NODE) {
      if ((node.textContent ?? "").trim() !== "") {
        return true;
      }
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) {
      continue;
    }
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]);
    }
  }
  return false;
}

/** Direct `<tr>` of the table PLUS the direct `<tr>` of its direct
 *  `<thead>`/`<tbody>`/`<tfoot>`, in RENDER order (thead → tbody / direct-`<tr>` →
 *  tfoot), NOT source order. HTML 4 required `<tfoot>` to be written BEFORE
 *  `<tbody>`, and browsers keep that source order in the DOM while rendering the
 *  footer last; flattening in source order would put footer rows first (and, with
 *  no `<thead>`, promote a footer row to the GFM header). Bucketing by section
 *  keeps the row order the user actually saw. Excludes nested-table rows. */
function directRows(table: Element): Element[] {
  const head: Element[] = [];
  const bodyRows: Element[] = []; // direct <tr> + <tbody> rows, in source order
  const foot: Element[] = [];
  let count = 0;
  const concat = (): Element[] => [...head, ...bodyRows, ...foot];
  // Running row cap fires per `<tr>` (a single browser-implicit `<tbody>` holds
  // every row): one past the limit is enough for the caller to reject.
  const push = (bucket: Element[], tr: Element): boolean => {
    bucket.push(tr);
    count++;
    return count > MAX_HTML_TABLE_ROWS;
  };
  for (const child of Array.from(table.children)) {
    const tag = child.tagName;
    if (tag === "TR") {
      if (push(bodyRows, child)) {
        return concat();
      }
    } else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") {
      const bucket = tag === "THEAD" ? head : tag === "TFOOT" ? foot : bodyRows;
      for (const grandchild of Array.from(child.children)) {
        if (grandchild.tagName === "TR") {
          if (push(bucket, grandchild)) {
            return concat();
          }
        }
      }
    }
  }
  return concat();
}

/** Direct `<th>`/`<td>` children of a row (nested-table cells are descendants of a
 *  `<td>`, not direct row children → excluded). */
function directCells(row: Element): HTMLTableCellElement[] {
  const cells: HTMLTableCellElement[] = [];
  for (const child of Array.from(row.children)) {
    if (child.tagName === "TH" || child.tagName === "TD") {
      cells.push(child as HTMLTableCellElement);
    }
  }
  return cells;
}

/** A cell's visible text, collapsed to one line. Iterative (explicit-stack)
 *  pre-order DFS — recursion would risk a stack overflow on deeply nested HTML.
 *  Block boundaries and `<br>` become spaces; SKIP_TAGS contribute nothing. */
function collectCellText(cell: Element): string {
  const parts: string[] = [];
  // Stack items are DOM nodes or a literal " " sentinel. Push children reversed so
  // they pop in document order; block elements are bracketed leading + trailing.
  const stack: Array<Node | string> = [];
  const seed = cell.childNodes;
  for (let i = seed.length - 1; i >= 0; i--) {
    stack.push(seed[i]);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) {
      continue;
    }
    if (tag === "BR") {
      parts.push(" ");
      continue;
    }
    const block = BLOCK_TAGS.has(tag);
    // LIFO: trailing sentinel (popped last), children reversed, leading sentinel
    // (popped first) → pop order is leading, children…, trailing.
    if (block) {
      stack.push(" ");
    }
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]);
    }
    if (block) {
      stack.push(" ");
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Backslash-escape the Markdown-inline-active characters that can form an
 *  explicit link/image/code/emphasis/strikethrough/highlight, plus `&` (HTML
 *  entity references), so a cell renders as LITERAL text. `\` is escaped FIRST
 *  so the backslashes added for the rest are not doubled. `&` is included so an
 *  entity-looking cell such as `&copy; 2024` round-trips verbatim instead of
 *  resolving to `© 2024` (a fidelity fix — entities carry no security weight,
 *  they are literal-text substitutions that cannot form structure). `=` is
 *  escaped because `==…==` is Quoll's inline highlight mark (like `~~` for
 *  strikethrough); without it a pasted cell containing literal `==x==` would
 *  round-trip into a live highlight. Escaping every `=` (not only `==` pairs)
 *  mirrors the `~` handling and is safe — `\=` renders as a literal `=`.
 *  `a|b`→`a\|b`; `a\b`→`a\\b`; `a\|b`→`a\\\|b`; `[x](y)`→`\[x\](y)`; `&copy;`→`\&copy;`; `==x==`→`\=\=x\=\=`. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[`*_[\]<~|&=]/g, "\\$&");
}

function rowToLine(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Convert a table-ONLY HTML fragment to a GFM table string, or `null` when the
 *  fragment is not a single top-level table (no table, ≥2 top-level tables, or
 *  meaningful prose alongside the table) or a cap is exceeded. Returning `null`
 *  for mixed content lets the caller defer to normal paste so surrounding text
 *  and sibling tables are preserved rather than silently dropped. */
export function htmlTableToGfm(html: string): string | null {
  if (html.length > MAX_HTML_TABLE_INPUT_CHARS) {
    return null;
  }
  let table: Element | null;
  let body: Element | null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    body = doc.body;
    // Only TOP-LEVEL tables (a nested cell-table is not a paste target). Require
    // EXACTLY one: 0 = nothing to convert, ≥2 = defer so no table is dropped.
    const topLevel = Array.from(doc.querySelectorAll("table")).filter((t) => !hasAncestorTable(t));
    table = topLevel.length === 1 ? topLevel[0] : null;
  } catch {
    return null; // belt-and-suspenders: parseFromString is spec'd not to throw
  }
  if (!table || !body) {
    return null;
  }
  // Prose alongside the table → defer to normal paste (no data loss).
  if (hasTextOutsideTable(body, table)) {
    return null;
  }
  const rows = directRows(table);
  if (rows.length === 0 || rows.length > MAX_HTML_TABLE_ROWS) {
    return null;
  }

  // Occupancy-grid spread. `pending[col]` = how many MORE rows a rowspan still
  // occupies that column.
  const grid: string[][] = [];
  const pending: number[] = [];
  let placed = 0; // source-cell expansion counter (bounds colspan blow-up)
  let maxCols = 0;

  for (const row of rows) {
    const cells = directCells(row);
    const out: string[] = [];
    let col = 0;

    for (const cell of cells) {
      // Skip columns still occupied by an ongoing rowspan.
      while ((pending[col] ?? 0) > 0) {
        out[col] = "";
        pending[col]--;
        col++;
        if (col > MAX_HTML_TABLE_COLS) {
          return null;
        }
      }
      const cspan = clampSpan(cell.colSpan, MAX_COLSPAN);
      const rspan = clampSpan(cell.rowSpan, MAX_ROWSPAN);
      const text = escapeCell(collectCellText(cell));
      for (let k = 0; k < cspan; k++) {
        out[col] = k === 0 ? text : "";
        // colspan WINS over any residual rowspan occupancy on this column
        // (deterministic degrade for overlapping/dirty HTML).
        pending[col] = rspan > 1 ? rspan - 1 : 0;
        col++;
        placed++;
        if (col > MAX_HTML_TABLE_COLS || placed > MAX_HTML_TABLE_CELLS) {
          return null;
        }
      }
    }

    // Drain: fill EVERY column up to the row's full width (covers plain empty
    // columns sitting BETWEEN two pending columns, not just a contiguous run).
    const width = Math.max(col, pending.length);
    while (col < width) {
      if ((pending[col] ?? 0) > 0) {
        pending[col]--;
      }
      out[col] = "";
      col++;
      if (col > MAX_HTML_TABLE_COLS) {
        return null;
      }
    }

    // Bound the RECTANGULAR size incrementally. `placed` counts only source-cell
    // colspan expansion; the drain/skip cells above (which balloon a narrow or
    // EMPTY row up to a prior wide row's width via `pending.length`) are not
    // counted, so a single wide row followed by many short/empty rows would
    // otherwise materialise rows×maxCols cells before any post-loop guard. Reject
    // as soon as the running rectangle would exceed the cap (≈51 rows for a
    // 1000-wide balloon, not thousands).
    const runningMaxCols = Math.max(maxCols, col);
    if ((grid.length + 1) * runningMaxCols > MAX_HTML_TABLE_CELLS) {
      return null;
    }

    if (col > maxCols) {
      maxCols = col;
    }
    grid.push(out);
  }

  if (maxCols === 0) {
    return null;
  }
  for (const out of grid) {
    while (out.length < maxCols) {
      out.push("");
    }
  }

  const lines: string[] = [];
  lines.push(rowToLine(grid[0])); // header
  lines.push(rowToLine(new Array(maxCols).fill("---"))); // delimiter
  for (let i = 1; i < grid.length; i++) {
    lines.push(rowToLine(grid[i]));
  }
  const gfm = lines.join("\n"); // no trailing newline — the handler adds terminators

  // <caption> lives INSIDE the table subtree (so hasTextOutsideTable skips it),
  // but it is visible text the plain-paste fallback would preserve — emit it as a
  // paragraph above the table rather than dropping it. GFM has no table-caption
  // syntax, so a leading paragraph is the faithful representation. Direct-child
  // <caption> only (a nested table's caption belongs to that table, which is
  // already excluded since we chose a top-level table).
  const captionEl = Array.from(table.children).find((c) => c.tagName === "CAPTION");
  // escapeCell covers inline-active chars, which is enough for a table cell (always
  // mid-line). The caption is emitted at LINE START, though, so it must also escape
  // the leading BLOCK markers that only activate there (heading `#`, blockquote `>`,
  // bullet `-`/`+`, thematic break `---`, ordered-list `1.`/`1)`) — else a caption
  // like `# Q3` would render as a heading. All are valid CommonMark punctuation
  // escapes, so the caption still round-trips as literal text.
  const caption = captionEl
    ? escapeCell(collectCellText(captionEl))
        .replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2")
        .replace(/^([#>+-])/, "\\$1")
    : "";
  return caption ? `${caption}\n\n${gfm}` : gfm;
}
