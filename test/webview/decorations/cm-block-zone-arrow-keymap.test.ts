// @vitest-environment happy-dom
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange, Transaction } from "@codemirror/state";
import { type DecorationSet, EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  blockZoneArrowDown,
  blockZoneArrowKeymap,
  blockZoneArrowUp,
} from "../../../src/webview/cm/decorations/block-zone-arrow-keymap.js";
import { quollBlockReplaceZones } from "../../../src/webview/cm/decorations/index.js";
import { tableBlockField } from "../../../src/webview/cm/table/index.js";

function rangesOf(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

// Force a COMPLETE parse and republish it into the field BEFORE any synchronous
// read. tableBlockField.create() builds from the LAZY syntaxTree(state); under
// CPU starvation the bounded initial parse can stop before reaching the table,
// leaving the field empty — a flake that only bit the full parallel suite (the
// `tableBlockField` length 0-vs-1 race). forceParsing(view, doc.length) advances
// the parse and dispatches so the field recomputes from the complete tree — the
// same "force AND publish" mechanism the production resync path uses
// (CellEditorController.revalidateOrResync). ensureSyntaxTree / fullTree alone
// would NOT fix it: they advance the parse but never republish into the field's
// snapshot. See LEARNING.md "syntaxTree(state) は LAZY".
function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(doc: string, selection: EditorSelection | SelectionRange): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      tableBlockField,
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

const TABLE = "| H1 | H2 |\n| -- | -- |\n| a1 | a2 |";
// Doc: "above\n\n<TABLE>\n\nbelow" — table sandwiched between paragraphs,
// blank-line separators so the GFM parser cleanly terminates the table
// (matches the field's existing tests, see TABLE/`after` mount comment).
const DOC = `above\n\n${TABLE}\n\nbelow`;
const TABLE_FROM = DOC.indexOf(TABLE);
const TABLE_TO = TABLE_FROM + TABLE.length;

describe("blockZoneArrowDown", () => {
  it("stops the caret on the table's first source line when ArrowDown would cross the widget", () => {
    // Caret on the blank line just above the table — its natural next line
    // is the table's first source line, which the widget makes atomic.
    const blankLineAboveTable = TABLE_FROM - 1;
    const view = mount(DOC, EditorSelection.cursor(blankLineAboveTable));
    try {
      // Pre-state: widget is rendered (caret is off the table).
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);

      const handled = blockZoneArrowDown(view);
      expect(handled).toBe(true);
      // Caret lands at the widget's first byte = first source line.from.
      expect(view.state.selection.main.head).toBe(TABLE_FROM);
      // Widget reveals (line-level overlap with the caret).
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("returns false when no zones exist (no table in doc)", () => {
    const view = mount("plain text\nmore text", EditorSelection.cursor(0));
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
      // Caret unmoved — defaults take over.
      expect(view.state.selection.main.head).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("returns false when the caret is INSIDE a widget zone (widget already revealed)", () => {
    // Caret inside the table → field returns zero zones → keymap defers.
    const insideTable = TABLE_FROM + 3;
    const view = mount(DOC, EditorSelection.cursor(insideTable));
    try {
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(0);
      expect(blockZoneArrowDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(insideTable);
    } finally {
      view.destroy();
    }
  });

  it("returns false when the next line is NOT in a zone (regular paragraph step)", () => {
    // Caret on "above", line below is the blank separator — not in a zone.
    const onAbove = 2;
    const view = mount(DOC, EditorSelection.cursor(onAbove));
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(onAbove);
    } finally {
      view.destroy();
    }
  });

  it("returns false at the last line of the document (no next line to cross)", () => {
    const view = mount(DOC, EditorSelection.cursor(DOC.length));
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(DOC.length);
    } finally {
      view.destroy();
    }
  });

  it("returns false for multi-cursor selections (lets defaults handle the multi-range case)", () => {
    const view = mount(
      DOC,
      EditorSelection.create([
        EditorSelection.cursor(TABLE_FROM - 1),
        EditorSelection.cursor(DOC.length),
      ])
    );
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("returns false for non-empty (extending) selections", () => {
    const view = mount(DOC, EditorSelection.range(0, TABLE_FROM - 1));
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("dispatches with userEvent='select' so history extension can merge undo groups", () => {
    const dispatched: string[] = [];
    const observer = EditorState.transactionFilter.of((tr) => {
      const ue = tr.annotation(Transaction.userEvent);
      if (ue !== undefined) {
        dispatched.push(ue);
      }
      return tr;
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(TABLE_FROM - 1),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage }),
        tableBlockField,
        observer,
      ],
    });
    const view = forceParse(new EditorView({ state, parent }));
    try {
      expect(blockZoneArrowDown(view)).toBe(true);
      expect(dispatched).toContain("select");
    } finally {
      view.destroy();
    }
  });

  it("lands on the SECOND table when probe falls in the second of two zones (loop progresses past non-matching zones)", () => {
    const doc = `${TABLE}\n\n${TABLE}\n\nafter`;
    // doc layout: TABLE (0..TABLE.length-1) + "\n" (TABLE.length) + "\n" (TABLE.length+1) + TABLE + ...
    // Empty gap line sits at position TABLE.length+1; second table starts at TABLE.length+2.
    const gapLineFrom = TABLE.length + 1;
    const secondTableFrom = TABLE.length + 2;
    const view = mount(doc, EditorSelection.cursor(gapLineFrom));
    try {
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(2);
      const handled = blockZoneArrowDown(view);
      expect(handled).toBe(true);
      expect(view.state.selection.main.head).toBe(secondTableFrom);
    } finally {
      view.destroy();
    }
  });

  it("does NOT preserve goal column — caret lands at zone.from (line.from), not source column", () => {
    // Caret at column 3 of "above". After ArrowDown, a goal-column-aware impl
    // would target column 3 of the first table line (TABLE_FROM + 3). This
    // impl deliberately lands at zone.from = TABLE_FROM (column 0).
    const goalCol3OnAbove = 3;
    const view = mount(DOC, EditorSelection.cursor(goalCol3OnAbove));
    try {
      expect(blockZoneArrowDown(view)).toBe(false);
      view.dispatch({ selection: { anchor: TABLE_FROM - 1 } });
      expect(blockZoneArrowDown(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(TABLE_FROM);
    } finally {
      view.destroy();
    }
  });
});

describe("mount — forces parse readiness (lazy-parse flake guard)", () => {
  it("widgetises a table that sits beyond the initial parse viewport", () => {
    // Deterministic reproduction of the historical full-suite flake (the
    // `tableBlockField` length 0-vs-1 race): tableBlockField.create() reads the
    // LAZY syntaxTree(state), which omits any table the bounded initial parse
    // has not yet reached. The real flake needed CPU starvation to truncate the
    // parse of a tiny doc; here we trigger the SAME root condition without luck
    // by pushing the table PAST CodeMirror's ~3000-char initial parse viewport,
    // so the create-time lazy tree provably lacks the Table node. A mount that
    // does not force+publish a complete parse yields an empty field. Revert the
    // forceParse step in mount() and this assertion goes red.
    const pad = "padding paragraph line.\n\n".repeat(200); // > 3000 chars
    const bigDoc = `${pad}${TABLE}\n\nbelow`;
    const tableFrom = bigDoc.indexOf(TABLE);
    expect(tableFrom).toBeGreaterThan(3000); // table is beyond the init viewport
    // Caret at doc start — off the table, so the reveal does not hide the widget.
    const view = mount(bigDoc, EditorSelection.cursor(0));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });
});

describe("blockZoneArrowUp", () => {
  it("stops the caret on the table's last source line when ArrowUp would cross the widget", () => {
    // Caret on the blank line just below the table — its natural previous
    // line is the table's last source line, which the widget makes atomic.
    const blankLineBelowTable = TABLE_TO + 1;
    const view = mount(DOC, EditorSelection.cursor(blankLineBelowTable));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);

      const handled = blockZoneArrowUp(view);
      expect(handled).toBe(true);
      // Caret lands at the widget's last byte = last source line.to.
      expect(view.state.selection.main.head).toBe(TABLE_TO);
      // Widget reveals (line-level overlap with the caret).
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("returns false at the first line of the document (no previous line to cross)", () => {
    const view = mount(DOC, EditorSelection.cursor(0));
    try {
      expect(blockZoneArrowUp(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("returns false when no zones exist", () => {
    const view = mount("plain text\nmore text", EditorSelection.cursor(11));
    try {
      expect(blockZoneArrowUp(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("returns false when the previous line is NOT in a zone", () => {
    // Caret on "below", prev line is blank separator — not in a zone.
    const onBelow = DOC.length - 2;
    const view = mount(DOC, EditorSelection.cursor(onBelow));
    try {
      expect(blockZoneArrowUp(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(onBelow);
    } finally {
      view.destroy();
    }
  });
});

describe("blockZoneArrowKeymap — precedence vs defaultKeymap", () => {
  function mountWithKeymap(doc: string, selection: EditorSelection | SelectionRange): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection,
      extensions: [
        markdown({ base: markdownLanguage }),
        tableBlockField,
        // Register defaults FIRST and our keymap SECOND, mirroring editor.ts.
        // If Prec.high is dropped from blockZoneArrowKeymap, the default
        // cursorLineDown wins and the caret leapfrogs the widget.
        keymap.of(defaultKeymap),
        blockZoneArrowKeymap(),
      ],
    });
    return forceParse(new EditorView({ state, parent }));
  }

  it("ArrowDown dispatched via runScopeHandlers lands caret at TABLE_FROM (Prec.high wins over defaultKeymap)", () => {
    const view = mountWithKeymap(DOC, EditorSelection.cursor(TABLE_FROM - 1));
    try {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      runScopeHandlers(view, event, "editor");
      expect(view.state.selection.main.head).toBe(TABLE_FROM);
    } finally {
      view.destroy();
    }
  });

  it("ArrowUp dispatched via runScopeHandlers lands caret at TABLE_TO (Prec.high wins over defaultKeymap)", () => {
    const view = mountWithKeymap(DOC, EditorSelection.cursor(TABLE_TO + 1));
    try {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      });
      runScopeHandlers(view, event, "editor");
      expect(view.state.selection.main.head).toBe(TABLE_TO);
    } finally {
      view.destroy();
    }
  });
});

describe("blockZoneArrow* — non-vertical keys unaffected", () => {
  // Home/End/selectAll are not on ArrowUp/Down bindings, so they cannot be
  // affected by this keymap. The pin here is "we did not export commands
  // that overload non-vertical keys" — the module surface is the contract.
  it("module exports exactly the two vertical Commands (no Home/End/selectAll shim)", async () => {
    const mod = await import("../../../src/webview/cm/decorations/block-zone-arrow-keymap.js");
    const exported = Object.keys(mod).sort();
    expect(exported).toEqual(
      ["blockZoneArrowDown", "blockZoneArrowKeymap", "blockZoneArrowUp"].sort()
    );
  });
});
