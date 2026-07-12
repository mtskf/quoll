// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  type TableModel,
  tableModels,
  tableSkeletonField,
} from "../../../src/webview/cm/table/table-skeleton.js";

const exts = (): Extension[] => [markdown({ base: markdownLanguage }), tableSkeletonField];

/** Oracle: a fresh, fully-parsed view's full walk → models (ranges + block
 *  ranges + slice + parse). Comparing the WHOLE model (incl. `table`) makes the
 *  `bounded ≡ fullWalk` battery pin parse-reuse soundness: a boundedUpdate that
 *  reused a stale parse for a table whose bytes changed would deep-differ here. */
function freshOracle(doc: string): TableModel[] {
  const p = document.createElement("div");
  document.body.appendChild(p);
  const v = new EditorView({ state: EditorState.create({ doc, extensions: exts() }), parent: p });
  try {
    forceParsing(v, v.state.doc.length, 10_000);
    return tableModels(v.state);
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
    forceParsing(view, view.state.doc.length, 10_000);
    // create() correctness on the fully-parsed initial doc.
    expect([...view.state.field(tableSkeletonField)]).toEqual(
      freshOracle(view.state.doc.toString())
    );
    for (const e of edits) {
      view.dispatch({ changes: e });
      const len = view.state.doc.length;
      // R2-2: when the post-edit tree is already complete, the boundedUpdate
      // branch ran during dispatch — assert its output BEFORE forceParsing so a
      // self-heal can't mask a bounded bug. (Codex finding 3 + R2-2.)
      if (syntaxTreeAvailable(view.state, len)) {
        expect([...view.state.field(tableSkeletonField)]).toEqual(
          freshOracle(view.state.doc.toString())
        );
      }
      forceParsing(view, len, 10_000); // publish → converge (also covers the G2 path)
      expect([...view.state.field(tableSkeletonField)]).toEqual(
        freshOracle(view.state.doc.toString())
      );
    }
  } finally {
    view.destroy();
  }
}

const T = "| H | I |\n| - | - |\n| a | b |\n";

describe("tableSkeletonField bounded ≡ fullWalk", () => {
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

  // R2-2: explicit bounded-path pin — NO forceParsing after the edit, so a broken
  // boundedUpdate (e.g. dropping a reused range) cannot be masked by self-heal.
  it("exercises the bounded path without self-heal masking (revert-check anchor)", () => {
    const p = document.createElement("div");
    document.body.appendChild(p);
    const view = new EditorView({
      state: EditorState.create({ doc: `${T}\n\nprose\n\n${T}`, extensions: exts() }),
      parent: p,
    });
    try {
      forceParsing(view, view.state.doc.length, 10_000); // fully parsed start
      view.dispatch({ changes: { from: 0, insert: "x" } }); // edit OUTSIDE both tables
      // A small in-place edit on a complete tree keeps the frontier at doc end.
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      // boundedUpdate's output, pre-self-heal, must equal the full walk.
      expect([...view.state.field(tableSkeletonField)]).toEqual(
        freshOracle(view.state.doc.toString())
      );
    } finally {
      view.destroy();
    }
  });
});

describe("list-nested table detection (real Lezer language)", () => {
  it("emits an emitting TableModel (table !== null) for a table nested in a list item", () => {
    const doc = "- item intro:\n\n  | A | B |\n  |---|---|\n  | 1 | 2 |\n";
    const models = freshOracle(doc);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.table).not.toBeNull();
    if (!m.table) {
      return;
    }
    expect(m.table.header.cells).toHaveLength(2);
    // The block range covers whole lines including the header line's own indent.
    expect(doc.slice(m.blockFrom, m.blockTo)).toBe("  | A | B |\n  |---|---|\n  | 1 | 2 |");
    // Full-doc caret offset (what table-widget uses: nodeFrom + cell.from = m.from
    // + cell.from). Pins the header-indent-outside-node / body-indent-inside-node
    // asymmetry end-to-end, so click-to-reveal lands the caret on the right byte.
    expect(m.from + m.table.header.cells[0].from).toBe(doc.indexOf("A"));
    expect(m.from + m.table.rows[0].cells[0].from).toBe(doc.indexOf("1"));
  });

  it("emits for a top-level 1-3-space-indented table too (same shape)", () => {
    const doc = "   | A | B |\n   |---|---|\n   | 1 | 2 |\n";
    const models = freshOracle(doc);
    expect(models).toHaveLength(1);
    expect(models[0].table).not.toBeNull();
    expect(models[0].table?.header.cells).toHaveLength(2);
  });

  it("stays non-emitting for a blockquote-nested table (out of scope)", () => {
    const doc = "> | A | B |\n> |---|---|\n> | 1 | 2 |\n";
    const models = freshOracle(doc);
    expect(models).toHaveLength(1);
    // Continuation lines carry `>` markers, not whitespace → still not a table.
    expect(models[0].table).toBeNull();
  });
});
