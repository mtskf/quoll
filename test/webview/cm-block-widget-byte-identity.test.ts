// @vitest-environment happy-dom
//
// Byte-identity round-trip oracle for the TABLE and FRONTMATTER block-widget
// fields — the widget-layer twin of cm-block-widget-bounded.test.ts (which
// oracles the IMAGE field). Both fields uphold the architecture invariant
// "widgets are display-only (byte-identical round-trip)": the widget CM renders
// captures the source slice verbatim and never mutates a byte. cm-table-widget
// / cm-frontmatter-widget assert DOM STRUCTURE only, so a widget that silently
// mutated the bytes it captured would pass them — this file closes that gap.
//
// Each fixture is checked TWO ways:
//
//   1. Byte anchor (the actual round-trip check — assertTable/FrontmatterByte-
//      Anchored): every emitted widget's captured slice is compared to the LIVE
//      document text via `sliceDoc` — an authority INDEPENDENT of the fields. A
//      systematic mutation in the shared capture path (trim, CRLF-normalise,
//      rewrite `m.slice`) is caught here even though it would corrupt a
//      field-vs-field comparison symmetrically. This is what makes the file a
//      byte-identity oracle rather than only a stale-cache check.
//   2. Bounded ≡ full (the stale-cache check — assertEquivalent): drive an
//      edit-sequence matrix through the live field (the "bounded" value,
//      incrementally maintained across transactions), then diff it against the
//      field computed from scratch on the same final EditorState (the "full"
//      oracle). `WidgetType.eq()` pins the widget identity — TableBlockWidget.eq
//      on (docFrom, slice, nodeFrom); FrontmatterBlockWidget.eq on slice — so an
//      incremental reuse that goes stale relative to a fresh recompute surfaces
//      as bounded ≢ full.
//
// (The image harness cm-block-widget-bounded.test.ts does only (2); the byte
// anchor (1) is the strengthening this file adds so a shared-path byte mutation
// cannot pass symmetrically.)
//
// Non-vacuity: the final describe block feeds a deliberately byte-mutating
// widget (its captured slice differs from source by one byte) through the SAME
// assertEquivalent the matrices use, and asserts it throws — proving the eq()
// comparison is not vacuous.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import { type DecorationSet, EditorView, type WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { parseTable } from "../../src/markdown/table/index.js";
import {
  FrontmatterBlockWidget,
  frontmatterBlockField,
} from "../../src/webview/cm/frontmatter/index.js";
import { hostDocumentReseed } from "../../src/webview/cm/host-reseed.js";
import {
  TableBlockWidget,
  tableBlockField,
  tableSkeletonField,
} from "../../src/webview/cm/table/index.js";

// ── shared slot + equivalence machinery (mirrors cm-block-widget-bounded) ──────

interface Slot {
  from: number;
  to: number;
  widget: WidgetType;
}

function slots(set: DecorationSet): Slot[] {
  const out: Slot[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to, widget: iter.value.spec.widget as WidgetType });
    iter.next();
  }
  return out;
}

function assertEquivalent(actual: Slot[], oracle: Slot[]): void {
  expect(actual.map((s) => ({ from: s.from, to: s.to }))).toEqual(
    oracle.map((s) => ({ from: s.from, to: s.to }))
  );
  for (let i = 0; i < oracle.length; i++) {
    expect(actual[i].widget.eq(oracle[i].widget)).toBe(true); // pins captured bytes
  }
}

// ── independent document-byte anchor (the actual byte-identity check) ───────────
//
// assertEquivalent (bounded ≡ full) proves incremental state == fresh recompute,
// but BOTH sides run the SAME production capture path — so a systematic mutation
// in that shared path (trimming trailing spaces, normalising line endings,
// rewriting `m.slice`) would corrupt actual AND oracle identically and still
// pass. To make this a genuine byte-identity round-trip oracle, anchor every
// emitted widget's captured slice to the live document text via `sliceDoc` — an
// authority independent of the fields. All fixtures are LF-only, so the CRLF→LF
// normalisation in the table capture is a no-op and the byte comparison is exact.

/** A table widget's captured `slice` must equal the document bytes over the
 *  region the block widget REPLACES — the decoration's own [from, to], an
 *  authority independent of the widget. Using the decoration's right boundary
 *  (not `nodeFrom + slice.length`) also catches a trailing truncation, which a
 *  slice-length-bounded compare would miss by matching only the prefix. All
 *  fixtures are LF-only + non-indented, so the node range equals the block
 *  range and the CRLF→LF normalisation is a no-op → an exact byte comparison. */
function assertTableByteAnchored(state: EditorState): void {
  for (const s of slots(state.field(tableBlockField))) {
    const w = s.widget as TableBlockWidget;
    expect(w.slice).toBe(state.sliceDoc(s.from, s.to));
  }
}

/** A frontmatter widget's captured `slice` must equal the document's bytes over
 *  the collapsed span, and its `body` must be the slice interior (opener/closer
 *  fence lines dropped) — both anchored to text, not to a second field copy. */
function assertFrontmatterByteAnchored(state: EditorState): void {
  const rs = state.field(frontmatterBlockField);
  if (rs.kind !== "collapsed") {
    return;
  }
  const { span } = rs;
  expect(span.slice).toBe(state.sliceDoc(span.from, span.to));
  expect(span.body).toBe(span.slice.split("\n").slice(1, -1).join("\n"));
}

interface Edit {
  changes?: { from: number; to?: number; insert?: string };
  // `EditorSelection.cursor()` / `.range()` return a SelectionRange (only
  // `.create()` returns an EditorSelection); TransactionSpec.selection accepts
  // both (SelectionRange satisfies its `{ anchor, head? }` arm structurally), so
  // the union mirrors the exact set of values every case actually passes.
  selection?: SelectionRange | EditorSelection;
  cursorAtEnd?: boolean; // resolve to cursor(doc.length) AFTER the change (avoids RangeError)
  reseed?: boolean; // dispatch with the hostDocumentReseed annotation (bypasses the fm veto)
}

// ── TABLE oracle ──────────────────────────────────────────────────────────────
//
// tableBlockField reads its widget slices from the bounded-maintained
// tableSkeletonField, so BOTH must be registered for the bounded path to run
// (absent, buildAll falls back to a full walk and the oracle would be vacuous).
// A live view + forceParsing is required: the field converges to the fully-
// parsed result via the tree-identity self-heal branch, exactly as
// cm-table-skeleton.test.ts drives it.

const tableExts = (): Extension[] => [
  EditorState.allowMultipleSelections.of(true),
  markdown({ base: markdownLanguage }),
  tableSkeletonField,
  tableBlockField,
];

/** Full oracle: a fresh, fully-parsed view's tableBlockField on `doc` +
 *  `selection` (the selection matters — the field drops widgets whose line-span
 *  overlaps a selection range). */
function tableFullSlots(doc: string, selection: EditorSelection): Slot[] {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, selection, extensions: tableExts() }),
    parent,
  });
  try {
    forceParsing(view, view.state.doc.length, 10_000);
    return slots(view.state.field(tableBlockField));
  } finally {
    view.destroy();
  }
}

function checkTableEquivalence(initial: string, edits: Edit[]): void {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: initial, extensions: tableExts() }),
    parent,
  });
  try {
    forceParsing(view, view.state.doc.length, 10_000);
    // create() correctness on the fully-parsed initial doc.
    assertEquivalent(
      slots(view.state.field(tableBlockField)),
      tableFullSlots(view.state.doc.toString(), view.state.selection)
    );
    assertTableByteAnchored(view.state);
    for (const e of edits) {
      view.dispatch({ changes: e.changes, selection: e.selection });
      if (e.cursorAtEnd) {
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
      }
      const len = view.state.doc.length;
      // Pre-self-heal bounded assertion: when the post-edit tree is already
      // complete, boundedUpdate ran during dispatch — check its output BEFORE
      // forceParsing so a self-heal can't mask a bounded byte bug (Codex R2-2,
      // cm-table-skeleton.test.ts). Whether or not the tree is synchronously
      // available here is harness-dependent, so this stays conditional and the
      // guaranteed bounded-path pin lives in its own test below.
      if (syntaxTreeAvailable(view.state, len)) {
        assertEquivalent(
          slots(view.state.field(tableBlockField)),
          tableFullSlots(view.state.doc.toString(), view.state.selection)
        );
        assertTableByteAnchored(view.state);
      }
      forceParsing(view, len, 10_000); // publish → converge (also covers the G2 path)
      assertEquivalent(
        slots(view.state.field(tableBlockField)),
        tableFullSlots(view.state.doc.toString(), view.state.selection)
      );
      assertTableByteAnchored(view.state);
    }
  } finally {
    view.destroy();
  }
}

const T = "| H | I |\n| - | - |\n| a | b |";

describe("tableBlockField byte-identity: bounded ≡ full", () => {
  const cases: Array<{ name: string; initial: string; edits: Edit[] }> = [
    {
      name: "type prose far from a table",
      initial: `# Top\n\nprose\n\n${T}\n\nmore`,
      edits: [{ changes: { from: 2, insert: "x" }, selection: EditorSelection.cursor(3) }],
    },
    {
      name: "introduce a standalone table from scratch",
      initial: "plain text\n",
      edits: [{ changes: { from: 0, to: 10, insert: T }, cursorAtEnd: true }],
    },
    {
      name: "insert a table before an existing one",
      initial: `${T}\n\n${T}\n`,
      edits: [{ changes: { from: 0, insert: `${T}\n\n` }, cursorAtEnd: true }],
    },
    {
      name: "edit a cell inside a table (slice must re-capture)",
      initial: `${T}\n\nbelow`,
      edits: [{ changes: { from: 2, insert: "Z" }, cursorAtEnd: true }],
    },
    {
      name: "delete a table",
      initial: `${T}\n\nmid\n\n${T}\n`,
      edits: [{ changes: { from: 0, to: T.length + 1 }, cursorAtEnd: true }],
    },
    // G1: a blank-line toggle ADJACENT to a table re-groups it without touching
    // the table's own bytes — the bounded reuse must still re-capture the range.
    {
      name: "G1: blank line after a table splits a trailing paragraph",
      initial: `${T}\ntrailer\n`,
      edits: [{ changes: { from: T.length, insert: "\n" }, cursorAtEnd: true }],
    },
    {
      name: "G1: delete the blank line between two tables (merge)",
      initial: `${T}\n\n${T}\n`,
      edits: [{ changes: { from: T.length, to: T.length + 1 }, cursorAtEnd: true }],
    },
    {
      name: "G3: frontmatter length shift before a table",
      initial: `---\ntitle: a\n---\n\n${T}\n`,
      edits: [{ changes: { from: 11, insert: "bb" }, cursorAtEnd: true }],
    },
    {
      name: "selection-only onto then off a table (overlap filter)",
      initial: `${T}\n\nbelow text`,
      edits: [{ selection: EditorSelection.cursor(3) }, { selection: EditorSelection.cursor(40) }],
    },
    {
      name: "multi-cursor far apart",
      initial: `${T}\n\nprose one\n\n${T}\n\ntail`,
      edits: [
        {
          changes: { from: T.length + 3, insert: "q" },
          selection: EditorSelection.create([
            EditorSelection.cursor(T.length + 4),
            EditorSelection.cursor(0),
          ]),
        },
      ],
    },
    {
      name: "sequence: prose edit, add a table, then delete it (bounded reuse across txns)",
      initial: `intro\n\n${T}\n`,
      edits: [
        { changes: { from: 0, insert: "x" }, selection: EditorSelection.cursor(1) },
        { changes: { from: 0, insert: `${T}\n\n` }, cursorAtEnd: true },
        { changes: { from: 0, to: T.length + 2 }, cursorAtEnd: true },
      ],
    },
  ];
  for (const c of cases) {
    it(c.name, () => checkTableEquivalence(c.initial, c.edits));
  }

  // Guaranteed bounded-path pin (mirrors cm-table-skeleton.test.ts's
  // no-self-heal anchor): a small in-place edit on a complete tree keeps the
  // frontier at doc end, so boundedUpdate ran during dispatch. Assert the tree
  // IS available (not conditional) and check the field's output — plus its
  // byte-anchor — BEFORE any forceParsing, so a broken bounded reuse can't be
  // masked by a self-heal. This is the case the matrix's conditional guard
  // cannot guarantee runs.
  it("exercises the bounded path without self-heal masking (revert-check anchor)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: `${T}\n\nprose\n\n${T}`, extensions: tableExts() }),
      parent,
    });
    try {
      forceParsing(view, view.state.doc.length, 10_000);
      view.dispatch({
        changes: { from: 0, insert: "x" }, // edit OUTSIDE both tables
        selection: EditorSelection.cursor(1),
      });
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      // boundedUpdate's output, pre-self-heal, must equal the full walk AND stay
      // anchored to the document bytes.
      assertEquivalent(
        slots(view.state.field(tableBlockField)),
        tableFullSlots(view.state.doc.toString(), view.state.selection)
      );
      assertTableByteAnchored(view.state);
    } finally {
      view.destroy();
    }
  });
});

// ── FRONTMATTER oracle ─────────────────────────────────────────────────────────
//
// frontmatterBlockField holds a RevealState (not a DecorationSet); its collapsed
// widget is FrontmatterBlockWidget(span.body, span.slice) over [span.from,
// span.to]. It re-detects the span fresh on every docChanged, so bounded ≡ full
// (check 2) is byte-safe by construction — that half is a regression guard
// against a future bounded-reuse optimisation going stale, and additionally pins
// the reveal-kind reducer (collapsed/absent transitions across the edit matrix).
// The load-bearing byte-identity check for frontmatter is therefore the anchor
// (check 1, assertFrontmatterByteAnchored): span.slice == sliceDoc(from,to) and
// span.body == the slice interior, both against the document — this is what
// catches a capture-path mutation that re-detection would reproduce on both
// sides. No syntax tree is involved (pure line model), so a bare EditorState +
// state.update() is enough; state.update applies the field's read-only
// transactionFilter, so mutation of a COLLAPSED block only lands via a host
// reseed, a whole-doc bulk replace, or span (de)formation from an absent state.
// The matrix never reveals the block, so both bounded and full stay collapsed
// and compare apples-to-apples.

const frontmatterExts = (): Extension[] => [
  EditorState.allowMultipleSelections.of(true),
  frontmatterBlockField,
];

/** Collapsed widget as a Slot, or `[]` in any other reveal state. */
function frontmatterSlots(state: EditorState): Slot[] {
  const rs = state.field(frontmatterBlockField);
  if (rs.kind !== "collapsed") {
    return [];
  }
  return [
    {
      from: rs.span.from,
      to: rs.span.to,
      widget: new FrontmatterBlockWidget(rs.span.body, rs.span.slice),
    },
  ];
}

function frontmatterFullSlots(doc: string, selection: EditorSelection): Slot[] {
  return frontmatterSlots(EditorState.create({ doc, selection, extensions: frontmatterExts() }));
}

function checkFrontmatterEquivalence(initial: string, edits: Edit[]): void {
  let state = EditorState.create({ doc: initial, extensions: frontmatterExts() });
  // create() correctness on the initial doc.
  assertEquivalent(frontmatterSlots(state), frontmatterFullSlots(initial, state.selection));
  assertFrontmatterByteAnchored(state);
  for (const e of edits) {
    state = state.update({
      changes: e.changes,
      selection: e.selection,
      annotations: e.reseed ? hostDocumentReseed.of(true) : undefined,
    }).state;
    if (e.cursorAtEnd) {
      state = state.update({ selection: EditorSelection.cursor(state.doc.length) }).state;
    }
    assertEquivalent(
      frontmatterSlots(state),
      frontmatterFullSlots(state.doc.toString(), state.selection)
    );
    assertFrontmatterByteAnchored(state);
  }
}

describe("frontmatterBlockField byte-identity: bounded ≡ full", () => {
  const cases: Array<{ name: string; initial: string; edits: Edit[] }> = [
    {
      name: "body edit far below leaves the collapsed block byte-identical",
      initial: "---\ntitle: x\ndraft: true\n---\n\nbody paragraph",
      edits: [{ changes: { from: 30, insert: " more" }, cursorAtEnd: true }],
    },
    {
      name: "form a frontmatter block by adding the closing fence (absent → collapsed)",
      initial: "---\ntitle: x\n",
      edits: [{ changes: { from: 13, insert: "---" }, cursorAtEnd: true }],
    },
    {
      name: "no frontmatter stays absent while the body is edited",
      initial: "# Title\n\nsome body",
      edits: [{ changes: { from: 9, insert: "X" }, cursorAtEnd: true }],
    },
    {
      name: "reseed rewrites the frontmatter body (new slice must re-capture)",
      initial: "---\na: 1\n---\nbody",
      edits: [{ changes: { from: 0, to: 16, insert: "---\na: 2\nb: 3\n---\nbody" }, reseed: true }],
    },
    {
      name: "reseed removes the frontmatter entirely (collapsed → absent)",
      initial: "---\na: 1\n---\nbody",
      edits: [{ changes: { from: 0, to: 16, insert: "just body now" }, reseed: true }],
    },
    {
      name: "bulk select-all replace overwrites frontmatter + body in one edit",
      initial: "---\na: 1\n---\nbody",
      edits: [
        { selection: EditorSelection.range(0, 16) },
        { changes: { from: 0, to: 16, insert: "---\nc: 9\n---\nnew" }, cursorAtEnd: true },
      ],
    },
    {
      name: "raw-fallback frontmatter (nested mapping) stays byte-identical on a body edit",
      initial: "---\nauthor:\n  name: x\n---\nbody",
      edits: [{ changes: { from: 26, insert: "!" }, cursorAtEnd: true }],
    },
    {
      name: "sequence: edit body, reseed to grow the block, reseed to drop it",
      initial: "---\na: 1\n---\nbody",
      edits: [
        { changes: { from: 16, insert: " tail" }, cursorAtEnd: true },
        {
          changes: { from: 0, to: 21, insert: "---\na: 1\nb: 2\nc: 3\n---\nbody tail" },
          reseed: true,
        },
        { changes: { from: 0, to: 31, insert: "no frontmatter" }, reseed: true },
      ],
    },
  ];
  for (const c of cases) {
    it(c.name, () => checkFrontmatterEquivalence(c.initial, c.edits));
  }
});

// ── non-vacuity ─────────────────────────────────────────────────────────────
//
// Prove the oracle actually catches a byte mutation: feed a widget whose
// captured slice differs from the real one by a single byte (identical range, so
// the structural check passes and only the eq() byte check can fail) through the
// same assertEquivalent the matrices use. If this did NOT throw, every case
// above would be vacuous.

function tableWidgetSlot(src: string, docFrom: number, nodeFrom: number): Slot {
  const table = parseTable(src, 0, src.length);
  if (table === null) {
    throw new Error("fixture must parse");
  }
  return {
    from: docFrom,
    to: docFrom + src.length,
    widget: new TableBlockWidget(table, src, docFrom, nodeFrom),
  };
}

describe("oracle non-vacuity — a byte-mutating widget fails assertEquivalent", () => {
  it("table: a one-byte slice mutation is rejected", () => {
    const src = "| a | b |\n| - | - |\n| c | d |";
    const mutated = src.replace("d", "X"); // same length → same range, one byte differs
    const real = [tableWidgetSlot(src, 0, 0)];
    const mutant = [tableWidgetSlot(mutated, 0, 0)];
    expect(() => assertEquivalent(real, mutant)).toThrow();
    // Sanity: identical slots must NOT throw (the throw above is the mutation, not noise).
    expect(() => assertEquivalent(real, real)).not.toThrow();
  });

  it("frontmatter: a one-byte slice mutation is rejected", () => {
    const good = [
      { from: 0, to: 12, widget: new FrontmatterBlockWidget("a: 1", "---\na: 1\n---") },
    ];
    const mutant = [
      { from: 0, to: 12, widget: new FrontmatterBlockWidget("a: 2", "---\na: 2\n---") },
    ];
    expect(() => assertEquivalent(good, mutant)).toThrow();
    expect(() => assertEquivalent(good, good)).not.toThrow();
  });
});
