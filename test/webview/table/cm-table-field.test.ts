// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  quollBlockReplaceZones,
  quollSyntaxReveal,
} from "../../../src/webview/cm/decorations/index.js";
import { inlineMarkReveal } from "../../../src/webview/cm/decorations/inline-mark-reveal.js";
import { splitToCmText } from "../../../src/webview/cm/seed.js";
import { tableBlockField } from "../../../src/webview/cm/table/index.js";
import type { TableBlockWidget } from "../../../src/webview/cm/table/table-widget.js";
import { fullTree } from "../helpers/full-tree.js";

function rangesOf(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

function mount(
  doc: string,
  selection?: EditorSelection | SelectionRange,
  extraExtensions: Array<unknown> = []
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  // CodeMirror's `EditorState.create` default selection is `cursor(0)`,
  // which would land on the first table's first character and trip the
  // line-level reveal in every "no explicit selection" test below. The
  // intent of those tests is "no selection touches the table"; default to
  // a cursor at the END of the doc so the reveal fast-path exit gate does
  // not fire and the widget emission is the thing under test. Tests that
  // want to pin the on-table reveal behaviour pass an explicit selection.
  //
  // Two-step create: build the state with no selection first so we can
  // read the resulting Text length (the string-length passed in may differ
  // from Text length when the input contains `\r\n` line separators — the
  // default `lineSeparator` splitter collapses `\r\n` to one byte).
  //
  const baseState = EditorState.create({
    doc,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      tableBlockField,
      ...(extraExtensions as never[]),
    ],
  });
  const effectiveSelection = selection ?? EditorSelection.cursor(baseState.doc.length);
  const state = EditorState.create({
    doc,
    selection: effectiveSelection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      tableBlockField,
      ...(extraExtensions as never[]),
    ],
  });
  return new EditorView({ state, parent });
}

const TABLE = "| H1 | H2 |\n| -- | -- |\n| a1 | a2 |";

describe("tableBlockField", () => {
  it("emits exactly one block Decoration.replace per well-formed Table node", () => {
    const view = mount(`${TABLE}\n`);
    try {
      const set = view.state.field(tableBlockField);
      expect(rangesOf(set)).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  it("emits the widget across whole-line boundaries (covers the source)", () => {
    const view = mount(`${TABLE}\n`);
    try {
      const set = view.state.field(tableBlockField);
      const ranges = rangesOf(set);
      expect(ranges).toHaveLength(1);
      const { from, to } = ranges[0];
      expect(from).toBe(0);
      expect(to).toBeGreaterThanOrEqual(TABLE.length);
    } finally {
      view.destroy();
    }
  });

  // Line-level reveal: the widget hides as soon as ANY selection range
  // touches a line that overlaps the table. Mirrors C5's
  // checkbox pattern so a single click on the block widget (CM6's default
  // click handler places the caret on the widget boundary) puts the caret
  // on a table line → reveal fires → source is editable.
  it("hides the widget when caret is inside the table (line-level reveal)", () => {
    const view = mount(`${TABLE}\n`, EditorSelection.cursor(3));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("hides the widget when caret is AT the table's first character (line.from boundary)", () => {
    // Half-open overlap (`r.from < to && from < r.to`) would NOT fire here
    // because r.from == r.to == from. Line-level overlap MUST fire.
    const view = mount(`${TABLE}\n`, EditorSelection.cursor(0));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("hides the widget when caret is AT the table's last content character (line.to boundary)", () => {
    const view = mount(`${TABLE}\n\nbelow`, EditorSelection.cursor(TABLE.length));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("DOES emit the widget when caret is on the empty line BELOW the table", () => {
    const doc = `${TABLE}\n\nbelow`;
    const view = mount(doc, EditorSelection.cursor(TABLE.length + 2));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  it("re-emits the widget after the caret moves off the table", () => {
    const view = mount(`${TABLE}\n\nbelow`, EditorSelection.cursor(3));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  it("handles multi-cursor: hides only the table whose line range a cursor touches", () => {
    // Trailing "\n\nafter" gives a non-table line below the second table
    // (separated by a blank line so the GFM parser cleanly terminates the
    // table — otherwise "after" gets absorbed as a body row). The second
    // cursor sits on "after" → off both tables; closed-interval reveal
    // would otherwise hide every table in a table-terminated doc (see
    // mount() and the line.from/line.to boundary tests above).
    const doc = `${TABLE}\n\nbelow\n\n${TABLE}\n\nafter`;
    const secondTableFirstCharOffset = doc.lastIndexOf(TABLE);
    const view = mount(
      doc,
      EditorSelection.create([
        EditorSelection.cursor(3), // inside first table
        EditorSelection.cursor(doc.length), // on "after" — off both tables
      ])
    );
    try {
      // First table hidden (caret inside), second table visible (no cursor).
      const ranges = rangesOf(view.state.field(tableBlockField));
      expect(ranges).toHaveLength(1);
      expect(ranges[0].from).toBeGreaterThanOrEqual(secondTableFirstCharOffset);
    } finally {
      view.destroy();
    }
  });

  it("publishes the widget range to the quollBlockReplaceZones facet", () => {
    const view = mount(`${TABLE}\n`);
    try {
      const zones = view.state.facet(quollBlockReplaceZones);
      expect(zones).toHaveLength(1);
      const fieldRanges = rangesOf(view.state.field(tableBlockField));
      expect(zones[0]).toEqual(fieldRanges[0]);
    } finally {
      view.destroy();
    }
  });

  it("publishes zero zones when the caret is inside the table", () => {
    const view = mount(`${TABLE}\n`, EditorSelection.cursor(3));
    try {
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("ignores a malformed table (header/delimiter cell-count mismatch)", () => {
    const view = mount("| A | B |\n| - |\n");
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("emits widgets for both tables when the document contains two", () => {
    const doc = `${TABLE}\n\n${TABLE}\n`;
    const view = mount(doc);
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(2);
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(2);
    } finally {
      view.destroy();
    }
  });

  it("updates after a doc edit that introduces a new table", () => {
    const view = mount("plain text");
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: `${TABLE}\n` },
      });
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  // error-handler Conf 92: table whose Lezer Table node has no trailing
  // newline (the canonical "no-newline-at-doc-end" stress case) must NOT
  // crash CM's `block: true` dispatch path. We exercise the same line-snap
  // code path by appending a blank-line separator + non-table content BELOW
  // so (a) the GFM parser cleanly terminates the Table node at the table's
  // last byte and (b) the helper's default off-table cursor can land on the
  // trailing content (closed-interval reveal would otherwise hide every
  // table in a table-only doc — see mount() comment). The widget snap is
  // the contract: it must cover the table's last line through its EOL even
  // when that EOL is the doc's final newline.
  it("handles a Table node with no trailing newline (line-snap precondition)", () => {
    const view = mount(`${TABLE}\n\nafter`);
    try {
      const ranges = rangesOf(view.state.field(tableBlockField));
      expect(ranges).toHaveLength(1);
      // Widget spans line-1.from (0) .. line-3.to (TABLE.length) — the
      // table's last source line ends at TABLE.length (the `|` byte) and
      // the snap MUST cover that whole line without spilling into the
      // separator newline or "after".
      expect(ranges[0].from).toBe(0);
      expect(ranges[0].to).toBe(TABLE.length);
    } finally {
      view.destroy();
    }
  });

  it("handles a CRLF-terminated table without crashing and emits a sane widget if Lezer recognises it", () => {
    const crlfTable = "| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n";
    const view = mount(crlfTable);
    try {
      const ranges = rangesOf(view.state.field(tableBlockField));
      // Lezer's GFM parser ignores CRLF tables in the version we pin
      // (Caveat 2 in test/markdown/table/lezer-parity.test.ts), so the
      // current contract is "either 0 widgets, or, if a future Lezer
      // version recognises CRLF, the widget range must be sane".
      expect(ranges.length).toBeLessThanOrEqual(1);
      for (const r of ranges) {
        expect(r.from).toBe(0);
        expect(r.to).toBeLessThanOrEqual(view.state.doc.length);
        expect(r.from).toBeLessThan(r.to);
      }
    } finally {
      view.destroy();
    }
  });

  // Selection-only fast path: a cursor move OUTSIDE every table must not
  // re-walk the tree. We can't directly observe "recomputed
  // or not" from outside, so the pin is "the DecorationSet identity is
  // preserved across the selection-only update". CodeMirror's RangeSet is
  // immutable, so identity equality is a valid contract.
  it("preserves DecorationSet identity when selection moves with no doc/tree change and no table is touched", () => {
    const doc = `${TABLE}\n\nbelow with some text`;
    const view = mount(doc, EditorSelection.cursor(doc.length));
    try {
      const before = view.state.field(tableBlockField);
      // Move caret to a different "below"-line position (still off the table).
      view.dispatch({ selection: { anchor: doc.length - 3 } });
      const after = view.state.field(tableBlockField);
      expect(after).toBe(before);
    } finally {
      view.destroy();
    }
  });

  it("DOES rebuild on selection move when the new selection lands on a previously-widgetised table", () => {
    const doc = `${TABLE}\n\nbelow`;
    const view = mount(doc, EditorSelection.cursor(doc.length));
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
      view.dispatch({ selection: { anchor: 3 } });
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });
});

// C4a integration. Pins that an inline mark INSIDE a rendered (caret-off)
// table is dropped by the orchestrator's facet read,
// AND that revealing the table (caret on) lets the inline mark come back
// because the facet contribution disappears.
describe("tableBlockField × C4a orchestrator integration", () => {
  it("drops inline reveal decorations inside the widget zone (caret off table)", () => {
    // Doc: a table that contains bold marks in a cell + a paragraph below
    // with its own bold marks. With caret on the paragraph (off-table), the
    // table is widgetised and its inline-mark decorations must be dropped
    // by C4a's facet read; the paragraph's marks must survive.
    const doc = "| **a** | b |\n| - | - |\n| c | d |\n\n**below**";
    const caretAtBelow = doc.length - 2;
    const view = mount(doc, EditorSelection.cursor(caretAtBelow), [quollSyntaxReveal()]);
    try {
      // Read every contributed decoration source.
      const sources = view.state.facet(EditorView.decorations);
      const merged = sources.map((s) => (typeof s === "function" ? s(view) : s));
      const insideTable: Array<{ from: number; to: number }> = [];
      const outsideTable: Array<{ from: number; to: number }> = [];
      const widgetRanges = rangesOf(view.state.field(tableBlockField));
      for (const set of merged) {
        const iter = set.iter();
        while (iter.value !== null) {
          // Skip the block widget itself — we're checking INLINE marks.
          const spec = iter.value.spec as { widget?: unknown };
          if (!spec.widget) {
            const range = { from: iter.from, to: iter.to };
            const inWidget = widgetRanges.some((w) => w.from <= range.from && range.to <= w.to);
            (inWidget ? insideTable : outsideTable).push(range);
          }
          iter.next();
        }
      }
      expect(insideTable).toEqual([]);
      expect(outsideTable.length).toBeGreaterThan(0);

      // Positive control: pin that the orchestrator WOULD have emitted
      // marks inside the table absent the exclusion zone. Read the raw
      // inline provider output directly so a vacuous "Lezer stopped
      // parsing marks inside cells" regression fails this test loudly
      // instead of silently passing for the wrong reason. Use a whole-
      // doc visibleRange so happy-dom's no-layout viewport (= empty
      // visibleRanges) does not short-circuit the provider.
      const rawSet = inlineMarkReveal.build({
        state: view.state,
        selection: view.state.selection,
        visibleRanges: [{ from: 0, to: view.state.doc.length }],
        tree: fullTree(view.state),
      });
      const rawInsideWidget: Array<{ from: number; to: number }> = [];
      const rawIter = rawSet.iter();
      while (rawIter.value !== null) {
        const range = { from: rawIter.from, to: rawIter.to };
        if (widgetRanges.some((w) => w.from <= range.from && range.to <= w.to)) {
          rawInsideWidget.push(range);
        }
        rawIter.next();
      }
      expect(rawInsideWidget.length).toBeGreaterThan(0);
    } finally {
      view.destroy();
    }
  });

  it("re-emits inline reveal decorations inside the table when caret enters it", () => {
    const doc = "| **a** | b |\n| - | - |\n| c | d |\n\n**below**";
    const view = mount(doc, EditorSelection.cursor(3), [quollSyntaxReveal()]);
    try {
      // With caret in the table, the widget is hidden and the facet is
      // empty — so C4a's orchestrator MUST decorate the table's inline
      // marks normally. `**a**` is a StrongEmphasis span with TWO
      // EmphasisMark children (the opening `**` and closing `**`), so
      // the exact count is 2 — a weaker `> 0` would not distinguish
      // "filter is correctly inactive" from "filter is inactive AND
      // half the marks went missing for another reason".
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
      const sources = view.state.facet(EditorView.decorations);
      const merged = sources.map((s) => (typeof s === "function" ? s(view) : s));
      const headerMarks: Array<{ from: number; to: number }> = [];
      for (const set of merged) {
        const iter = set.iter();
        while (iter.value !== null) {
          const spec = iter.value.spec as { widget?: unknown };
          if (!spec.widget && iter.from < 13) {
            // First line is "| **a** | b |" — length 13.
            headerMarks.push({ from: iter.from, to: iter.to });
          }
          iter.next();
        }
      }
      expect(headerMarks).toHaveLength(2);
    } finally {
      view.destroy();
    }
  });
});

describe("tableBlockField — frontmatter exclusion (C8a guard)", () => {
  it("does NOT emit for a table INSIDE a leading-frontmatter span", () => {
    // The frontmatter block owns the outermost block over [0, closer]; a table
    // in the body must not also emit a competing block decoration. Blank line
    // before the closer so the trailing `---` is a thematic break, not a setext
    // underline absorbing the table.
    const view = mount("---\n| a | b |\n| - | - |\n\n---\n\n# body\n");
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });
});

describe("tableBlockField — reveal and offset pins", () => {
  it("drops the widget when the selection overlaps the table's lines (reveal)", () => {
    // Default cursor (doc end) is off the table → widget present.
    const view = mount("text\n\n| a | b |\n| - | - |\n\nmore");
    try {
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(1);
      // Move caret onto the first table line → widget hides.
      const onTable = view.state.doc.line(3).from; // "| a | b |"
      view.dispatch({ selection: { anchor: onTable } });
      expect(rangesOf(view.state.field(tableBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("stamps LF-internal offsets for a CRLF-seeded document (no \\r re-addition)", () => {
    // Production seeds via splitToCmText which strips \r → CM is LF-internal.
    // Trailing \r\n ensures the cursor at doc.length lands after the table.
    const raw = "| a | b |\r\n| - | - |\r\n| c | d |\r\n";
    const lfText = splitToCmText(raw);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: lfText,
        selection: EditorSelection.cursor(lfText.length),
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          markdown({ base: markdownLanguage }),
          tableBlockField,
        ],
      }),
    });
    try {
      const set = view.state.field(tableBlockField);
      let widget: TableBlockWidget | null = null;
      set.between(0, view.state.doc.length, (_f, _t, deco) => {
        if (widget === null) {
          widget = (deco.spec.widget as TableBlockWidget) ?? null;
        }
      });
      if (!widget) {
        throw new Error("no table widget");
      }
      // toDOM reads the quollResourceBaseUri facet from view.state, so the
      // stub needs a real (empty) EditorState (no facet value → base "").
      const dom = (widget as TableBlockWidget).toDOM({
        state: EditorState.create({}),
        dispatch() {},
      } as unknown as EditorView);
      // LF doc "| a | b |\n| - | - |\n| c | d |\n": first body cell 'c' content
      // is at offset 22 (row-3 '|'=20, ' '=21, 'c'=22), NOT 24 (adding \r back)
      // and NOT 20 (the line start).
      expect((dom.querySelector("tbody td") as HTMLElement).dataset.cellFrom).toBe("22");
    } finally {
      view.destroy();
    }
  });
});
