// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { BuiltBlock } from "../../../src/webview/cm/structural-blocks.js";
import { touchesStructuralReparse } from "../../../src/webview/cm/structural-guard.js";
import { type TableBlock, tableBlockField } from "../../../src/webview/cm/table/table-field.js";
import { settledMount, settledView } from "../helpers/settled-view.js";
import { recordsOf } from "../helpers/structural-records.js";
import { withUnstarvedFrontier } from "../helpers/unstarved-frontier.js";

const exts = (): Extension[] => [markdown({ base: markdownLanguage }), tableBlockField];

/** The field's canonical records: block range + payload. */
const blocks = (state: EditorState): BuiltBlock<TableBlock>[] =>
  recordsOf(state.field(tableBlockField).records);

/** Oracle: a fresh, fully-parsed view's full walk → blocks (block range + node offset +
 *  slice + parse). Comparing the WHOLE block (incl. `table`) makes the `bounded ≡ fullWalk`
 *  battery pin parse-reuse soundness: a bounded update that reused a stale parse for a
 *  table whose bytes changed would deep-differ here. */
function freshOracle(doc: string): BuiltBlock<TableBlock>[] {
  const p = document.createElement("div");
  document.body.appendChild(p);
  const v = new EditorView({ state: EditorState.create({ doc, extensions: exts() }), parent: p });
  try {
    settledView(v, 10_000);
    return blocks(v.state);
  } finally {
    v.destroy();
  }
}

function checkEquivalence(
  initial: string,
  edits: Array<{ from: number; to?: number; insert?: string }>
): void {
  const p = document.createElement("div");
  document.body.appendChild(p);
  const view = new EditorView({
    state: EditorState.create({ doc: initial, extensions: exts() }),
    parent: p,
  });
  try {
    settledView(view, 10_000);
    // create() correctness on the fully-parsed initial doc.
    expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
    for (const e of edits) {
      view.dispatch({ changes: e });
      const len = view.state.doc.length;
      // R2-2: when the post-edit tree is already complete, the bounded update
      // branch ran during dispatch — assert its output BEFORE forceParsing so a
      // self-heal can't mask a bounded bug. (Codex finding 3 + R2-2.)
      if (syntaxTreeAvailable(view.state, len)) {
        expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
      }
      settledView(view, 10_000); // publish → converge (also covers the G2 path)
      expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
    }
  } finally {
    view.destroy();
  }
}

const T = "| H | I |\n| - | - |\n| a | b |\n";

describe("tableBlockField bounded ≡ fullWalk", () => {
  const cases: Array<{
    name: string;
    initial: string;
    edits: Array<{ from: number; to?: number; insert?: string }>;
  }> = [
    {
      name: "type prose far from a table",
      initial: `# Top\n\nprose\n\n${T}\nmore`,
      edits: [{ from: 2, insert: "x" }],
    },
    {
      name: "introduce a table from scratch",
      initial: "plain text\n",
      edits: [{ from: 0, to: 10, insert: T }],
    },
    {
      name: "insert a table before an existing one",
      initial: `${T}\n${T}`,
      edits: [{ from: 0, insert: `${T}\n` }],
    },
    {
      name: "edit a cell inside a table",
      initial: `${T}\nbelow`,
      edits: [{ from: 2, insert: "Z" }],
    },
    {
      name: "delete a table",
      initial: `${T}\nmid\n\n${T}`,
      edits: [{ from: 0, to: T.length + 1 }],
    },
    {
      name: "G1: blank line after a table (split trailing paragraph)",
      initial: `${T}trailer\n`,
      edits: [{ from: T.length, insert: "\n" }],
    },
    {
      name: "G1: delete blank line between two tables (merge)",
      initial: `${T}\n${T}`,
      edits: [{ from: T.length, to: T.length + 1 }],
    },
    {
      name: "blockquote Table before a body table (both counted)",
      initial: `> | a |\n> | - |\n\n${T}`,
      edits: [{ from: T.length, insert: "x" }],
    },
    {
      name: "frontmatter then a table",
      initial: `---\ntitle: a\n---\n\n${T}`,
      edits: [{ from: 11, insert: "bb" }],
    },
    // multi-step: several edits in sequence (each asserted) stresses bounded reuse across transactions.
    {
      name: "sequence: prose edit, then add a table, then delete it",
      initial: `intro\n\n${T}`,
      edits: [
        { from: 0, insert: "x" },
        { from: 0, insert: `${T}\n` },
        { from: 0, to: T.length + 1 },
      ],
    },
    {
      name: "insert a char in prose immediately before a table",
      initial: `intro\n${T}`,
      edits: [{ from: 5, insert: "X" }], // end of "intro", the line above the table
    },
    {
      name: "insert a newline immediately before a table (shifts blockFrom)",
      initial: `intro\n${T}`,
      edits: [{ from: 6, insert: "\n" }], // between "intro\n" and the table's first line
    },
  ];
  for (const c of cases) {
    it(c.name, () => checkEquivalence(c.initial, c.edits));
  }

  // R2-2: explicit bounded-path pins — NO settling after the edit, so a broken
  // bounded update cannot be masked by self-heal.
  //
  // The contract's bounded update has two halves and one anchor reaches only one of them,
  // so there are two. The REUSE half rebases a record whose block falls outside the span;
  // the RE-WALK half walks the span and builds a block per matched node. An anchor whose
  // span holds no `Table` node exercises the first and leaves the second running on an
  // empty range, which is green whatever the re-walk does. The sibling below puts the span
  // ON a table so the record is NOT reused and the re-walk is what produces it.
  it("exercises the bounded path without self-heal masking (revert-check anchor)", () => {
    const doc = `${T}\n\nprose\n\n${T}`;
    withUnstarvedFrontier({
      what: "the bounded update's pre-self-heal output",
      mount: (parent) =>
        settledMount({ state: EditorState.create({ doc, extensions: exts() }), parent }, 10_000),
      observe: (view, requireUnstarvedFrontier) => {
        // Offset chosen to land INSIDE the `prose` paragraph, i.e. OUTSIDE both tables'
        // node ranges. That is what keeps this test on the REUSE half of the bounded update
        // (the sibling below puts the edit's span ON a table to exercise the RE-WALK half
        // instead) — it is no longer about pipe presence: the narrowed TABLE-DELIM arm is
        // a per-line SHAPE delta (`tableRowShapeChanged`), not "any `|` on the line", so an
        // in-cell keystroke that leaves a row's shape unchanged stays on the bounded arm
        // too. The negative pin below still guards against a regression that would route
        // this specific edit to the FULL walk.
        const proseAt = doc.indexOf("prose") + 2;
        const tr = view.state.update({ changes: { from: proseAt, insert: "x" } });
        expect(touchesStructuralReparse(tr)).toBe(false); // this edit really is on the bounded arm
        view.dispatch(tr);
        // A small in-place edit on a complete tree normally keeps the frontier at doc end,
        // which is what makes the bounded update the branch that ran. Under CPU starvation the
        // 20ms reparse budget can elapse before any parse work happens; the field then
        // takes its G2 fallback and full-walks DURING the dispatch, so there is no bounded
        // output to compare and this attempt is abandoned rather than red. An all-starved
        // run throws.
        requireUnstarvedFrontier();
        // The bounded update's output, pre-self-heal, must equal the full walk.
        expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
      },
    });
  });

  it("exercises the bounded RE-WALK arm without self-heal masking (revert-check anchor)", () => {
    // The table starts on the line directly below the edit, so the ±1-line span expansion
    // pulls the table's FIRST LINE into the span. That is enough on both sides: the mapped
    // block intersects the span, so it is not reused — and that term is the ONLY thing
    // carrying this side here, because the sibling `touchesRange` guard measures `false`
    // (the insert ends at old offset 5, one short of the old block's `from` of 6, and CM's
    // `touchesRange` needs `end >= from`); and the span walk visits every Table node
    // OVERLAPPING the interval — not only contained ones — so it rebuilds the whole block. Same
    // offset as the settled `insert a char in prose immediately before a table` row above;
    // what this adds is the absence of settling, so the self-heal cannot supply the answer.
    const doc = `intro\n${T}`;
    withUnstarvedFrontier({
      what: "the bounded update's pre-self-heal output on the re-walk arm",
      mount: (parent) =>
        settledMount({ state: EditorState.create({ doc, extensions: exts() }), parent }, 10_000),
      observe: (view, requireUnstarvedFrontier) => {
        // End of `intro` — prose, with no table-shape signal (no `|`, no delimiter row, no
        // cell-count change) for the narrowed TABLE-DELIM arm to fire on, and no other
        // structural shape either. The negative pin keeps that from drifting into the FULL
        // arm, where this would compare a full walk against a full walk.
        const tr = view.state.update({ changes: { from: 5, insert: "X" } });
        expect(touchesStructuralReparse(tr)).toBe(false);
        view.dispatch(tr);
        requireUnstarvedFrontier();
        expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
      },
    });
  });

  // Structural reparse: an edit re-shapes block boundaries OUTSIDE the changed span while
  // the post-edit frontier stays COMPLETE. Neither guard the field had could see it — the
  // bounded reuse rule (`!touched && !intersects(span, …)`) only looks at the changed
  // lines ±1, and G2 never fires because the frontier is not starved. Both directions are
  // covered: a node that VANISHES leaves a stale record behind, and a node that APPEARS is
  // missed entirely. Each row's mechanism is distinct at the Lezer level (fence pairing,
  // HTML-block absorption, fence RE-pairing), not three spellings of one bug.
  //
  // These go through `withUnstarvedFrontier`, NOT `checkEquivalence`: that harness skips
  // its pre-settle comparison when the frontier is starved and self-heals in its post-
  // settle one, so a structural row there would pass vacuously under CPU load.
  const structuralCases: Array<{
    name: string;
    doc: string;
    edit: { from: number; to?: number; insert?: string };
  }> = [
    {
      name: "an unclosed ``` fence opened above swallows the table",
      doc: `intro\n\n${T}\ntail\n`,
      edit: { from: 0, insert: "```" },
    },
    {
      name: "an HTML comment opened above swallows the table",
      doc: `intro\n\n${T}\ntail\n`,
      edit: { from: 0, to: 5, insert: "<!--" },
    },
    {
      name: "breaking an unclosed fence above REVEALS a table that was inside it",
      doc: `\`\`\`\n\n${T}\ntail\n`,
      edit: { from: 0, to: 1, insert: "" },
    },
  ];
  for (const c of structuralCases) {
    it(`structural reparse: ${c.name}`, () => {
      withUnstarvedFrontier({
        what: "the post-structural-edit records, pre-self-heal",
        mount: (parent) =>
          settledMount(
            { state: EditorState.create({ doc: c.doc, extensions: exts() }), parent },
            10_000
          ),
        observe: (view, requireUnstarvedFrontier) => {
          view.dispatch({ changes: c.edit });
          requireUnstarvedFrontier();
          expect(blocks(view.state)).toEqual(freshOracle(view.state.doc.toString()));
        },
      });
    });
  }
});

describe("list-nested table detection (real Lezer language)", () => {
  it("emits a block for a table nested in a list item", () => {
    const doc = "- item intro:\n\n  | A | B |\n  |---|---|\n  | 1 | 2 |\n";
    const found = freshOracle(doc);
    expect(found).toHaveLength(1);
    const b = found[0];
    expect(b.block.table.header.cells).toHaveLength(2);
    // The block range covers whole lines including the header line's own indent.
    expect(doc.slice(b.from, b.to)).toBe("  | A | B |\n  |---|---|\n  | 1 | 2 |");
    // Full-doc caret offset (what table-widget uses: nodeFrom + cell.from, with nodeFrom =
    // from + nodeOffset). Pins the header-indent-outside-node / body-indent-inside-node
    // asymmetry end-to-end, so click-to-reveal lands the caret on the right byte.
    const nodeFrom = b.from + b.block.nodeOffset;
    expect(nodeFrom + b.block.table.header.cells[0].from).toBe(doc.indexOf("A"));
    expect(nodeFrom + b.block.table.rows[0].cells[0].from).toBe(doc.indexOf("1"));
  });

  it("emits for a top-level 1-3-space-indented table too (same shape)", () => {
    const doc = "   | A | B |\n   |---|---|\n   | 1 | 2 |\n";
    const found = freshOracle(doc);
    expect(found).toHaveLength(1);
    expect(found[0].block.table.header.cells).toHaveLength(2);
  });

  it("yields no block for a blockquote-nested table (out of scope)", () => {
    const doc = "> | A | B |\n> |---|---|\n> | 1 | 2 |\n";
    // Continuation lines carry `>` markers, not whitespace → `parseTable` rejects the node,
    // so it stays raw source.
    expect(freshOracle(doc)).toEqual([]);
  });
});

// Local copy of the identity check used by test/extension/types-equality.test.ts's
// "table model type pins" describe block. Kept local so this file does not depend on that
// program's imports.
type AssertEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe("TableBlock readonly contract (type-only compile pin)", () => {
  it("keeps every field of TableBlock readonly", () => {
    // `slice` is the widget's eq() key (see the field doc in table-field.ts) — it must stay
    // readonly so a block can never be mutated after construction; the other fields carry
    // the same never-patched-after-build contract (the contract rebases a reused block by
    // keeping the same payload object and moving only its range, never by writing into it).
    //
    // `Readonly<T>` is homomorphic, so `AssertEqual<T, Readonly<T>>` holds only when EVERY
    // field of T is already readonly — including fields added later. Revert-check: drop
    // `readonly` from any single field of `TableBlock` in table-field.ts and this
    // assertion resolves to `false`, failing the `= true` assignment.
    const _check: AssertEqual<TableBlock, Readonly<TableBlock>> = true;
    expect(_check).toBe(true);
  });
});
