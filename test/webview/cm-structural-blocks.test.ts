// @vitest-environment happy-dom
//
// The structural block contract (src/webview/cm/structural-blocks.ts) as seen by its two
// production consumers, table and image block widgets. Rows that are revert-check
// evidence are written against names that exist both before and after the contract
// landed (`tableBlockField`, `imageBlockField`, decorations read through the
// `EditorView.decorations` facet and filtered by widget class), so the same row can be
// run on either revision.
//
// Precondition asserts are separate `expect`s from the behaviour assert, so a harness
// failure is never read as "behaviour absent".
import { ensureSyntaxTree, foldable, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type StateField } from "@codemirror/state";
import { Decoration, EditorView, type WidgetType } from "@codemirror/view";
import { type Tree, TreeFragment } from "@lezer/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calloutMarkerConcealField } from "../../src/webview/cm/decorations/callout-marker-conceal.js";
import { fencedCodeCollapseField } from "../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { headingFoldGutterLineClass } from "../../src/webview/cm/fold/index.js";
import type { imageBlockField } from "../../src/webview/cm/image/image-field.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import {
  type BuiltBlock,
  recordAt,
  type StructuralBlockSpec,
  type StructuralBlockState,
  type StructuralRecordSet,
  structuralBlockWidgets,
} from "../../src/webview/cm/structural-blocks.js";
import {
  requiresFullBoundedRebuild,
  touchesStructuralReparse,
} from "../../src/webview/cm/structural-guard.js";
import type { TableBlock } from "../../src/webview/cm/table/table-field.js";
import { QuollWidget } from "../../src/webview/cm/widget-base.js";
import { settledState } from "./helpers/settled-state.js";
import { settledMount } from "./helpers/settled-view.js";
import { recordsOf, recordWidgetsOf } from "./helpers/structural-records.js";
import { withUnstarvedFrontierState } from "./helpers/unstarved-frontier.js";

// One switch for both throwing seams. A mock only throws while `armed` is true, so the
// fields' `create` (which already calls both seams) never throws at mount.
const seam = vi.hoisted(() => ({ armed: false, armedCalls: 0, log: [] as string[] }));

// The specifier the table block field imports `parseTable` from.
vi.mock("../../src/markdown/table/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/markdown/table/index.js")>();
  return {
    ...real,
    parseTable: (source: string, from: number, to: number) => {
      seam.log.push(source);
      if (seam.armed) {
        seam.armedCalls++;
        if (source.includes("BOOM")) {
          throw new Error("parseTable armed to throw");
        }
      }
      return real.parseTable(source, from, to);
    },
  };
});

// The specifier the image block field imports `commonMarkAltText` from.
vi.mock("../../src/webview/cm/inline/inline-ir.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/webview/cm/inline/inline-ir.js")>();
  return {
    ...real,
    commonMarkAltText: (raw: string) => {
      seam.log.push(raw);
      if (seam.armed) {
        seam.armedCalls++;
        if (raw.includes("BOOM")) {
          throw new Error("commonMarkAltText armed to throw");
        }
      }
      return real.commonMarkAltText(raw);
    },
  };
});

afterEach(() => {
  seam.armed = false;
  seam.armedCalls = 0;
  seam.log.length = 0;
  vi.restoreAllMocks();
});

interface Slot {
  from: number;
  to: number;
  widget: WidgetType;
}

/** Every block widget of class `cls` the state's decoration facet carries, in order. */
function widgetSlots(state: EditorState, cls: abstract new (...args: never[]) => WidgetType) {
  const out: Slot[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") {
      continue;
    }
    const iter = source.iter();
    while (iter.value !== null) {
      const widget = iter.value.spec.widget as WidgetType | undefined;
      if (widget instanceof cls) {
        out.push({ from: iter.from, to: iter.to, widget });
      }
      iter.next();
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

const HOOK_LOG = "[quoll] structural block hook threw";
function hookLogCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith(HOOK_LOG)).length;
}

function mountView(state: EditorState): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return settledMount({ state, parent }, 10_000);
}

// A marker-line list table (its ListItem fold is the fold gate's subject), a second table
// that also fails once armed, and a healthy sibling.
const TABLE_DOC = [
  "Intro paragraph.",
  "",
  "- | BOOM | b |",
  "  | - | - |",
  "  | c | d |",
  "",
  "Middle paragraph.",
  "",
  "| BOOM2 | y |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "| ok | z |",
  "| - | - |",
  "| 3 | 4 |",
  "",
  "Tail paragraph.",
  "",
].join("\n");

const IMAGE_DOC = [
  "Intro paragraph.",
  "",
  "![BOOM alt](https://example.com/a.png)",
  "",
  "Middle paragraph.",
  "",
  "![ok alt](https://example.com/b.png)",
  "",
  "![BOOM2 alt](https://example.com/c.png)",
  "",
  "Tail paragraph.",
  "",
].join("\n");

describe("structural block hook failure leaves the block raw", () => {
  it("failure table: a throwing parseTable keeps the edit, the sibling widget and the list fold", async () => {
    vi.resetModules();
    const { tableBlockField, TableBlockWidget } = await import(
      "../../src/webview/cm/table/index.js"
    );
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const extensions: Extension[] = [quollMarkdownLanguage(), tableBlockField];
    const view = mountView(EditorState.create({ doc: TABLE_DOC, extensions }));
    try {
      const doc0 = view.state.doc;
      const targetLine = doc0.line(3); // "- | BOOM | b |"
      const siblingFrom = TABLE_DOC.indexOf("| ok |");
      const second = TABLE_DOC.indexOf("| BOOM2 |");
      // Precondition: the field built all three tables, and the widget over the marker
      // line suppresses that ListItem's fold.
      expect(widgetSlots(view.state, TableBlockWidget).map((s) => s.from)).toEqual([
        targetLine.from,
        second,
        siblingFrom,
      ]);
      expect(foldable(view.state, targetLine.from, targetLine.to)).toBeNull();

      seam.armed = true;
      const insideTarget = TABLE_DOC.indexOf("BOOM") + 4;
      expect(() => view.dispatch({ changes: { from: insideTarget, insert: "x" } })).not.toThrow();
      expect(seam.armedCalls).toBeGreaterThan(0); // the armed seam really ran
      const tail = view.state.doc.toString().indexOf("Tail paragraph.");
      expect(() => view.dispatch({ changes: { from: tail, insert: "y" } })).not.toThrow();

      const text = view.state.doc.toString();
      expect(text).toContain("- | BOOMx | b |");
      expect(text).toContain("yTail paragraph.");
      const slots = widgetSlots(view.state, TableBlockWidget).map((s) => s.from);
      expect(slots).toContain(text.indexOf("| ok |"));
      expect(slots).not.toContain(view.state.doc.line(3).from);
      // No widget over the marker line → its ListItem fold is offered again.
      const line3 = view.state.doc.line(3);
      expect(foldable(view.state, line3.from, line3.to)).not.toBeNull();
      expect(hookLogCount(errorSpy)).toBe(1);

      // A second table failing on the same arm logs nothing more.
      const insideSecond = text.indexOf("BOOM2") + 5;
      expect(() => view.dispatch({ changes: { from: insideSecond, insert: "z" } })).not.toThrow();
      expect(view.state.doc.toString()).toContain("| BOOM2z | y |");
      expect(hookLogCount(errorSpy)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("failure image: a throwing alt helper keeps the edit and the sibling widget", async () => {
    vi.resetModules();
    const { imageBlockField, ImageBlockWidget } = await import(
      "../../src/webview/cm/image/index.js"
    );
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const extensions: Extension[] = [quollMarkdownLanguage(), imageBlockField];
    const view = mountView(EditorState.create({ doc: IMAGE_DOC, extensions }));
    try {
      const target = IMAGE_DOC.indexOf("![BOOM alt]");
      const sibling = IMAGE_DOC.indexOf("![ok alt]");
      const second = IMAGE_DOC.indexOf("![BOOM2 alt]");
      // Precondition: all three standalone images have a widget.
      expect(widgetSlots(view.state, ImageBlockWidget).map((s) => s.from)).toEqual([
        target,
        sibling,
        second,
      ]);

      seam.armed = true;
      expect(() => view.dispatch({ changes: { from: target + 6, insert: "x" } })).not.toThrow();
      expect(seam.armedCalls).toBeGreaterThan(0);
      const tail = view.state.doc.toString().indexOf("Tail paragraph.");
      expect(() => view.dispatch({ changes: { from: tail, insert: "y" } })).not.toThrow();

      const text = view.state.doc.toString();
      expect(text).toContain("![BOOMx alt]");
      expect(text).toContain("yTail paragraph.");
      const slots = widgetSlots(view.state, ImageBlockWidget).map((s) => s.from);
      expect(slots).toContain(text.indexOf("![ok alt]"));
      expect(slots).not.toContain(text.indexOf("![BOOMx alt]"));
      expect(hookLogCount(errorSpy)).toBe(1);

      const insideSecond = text.indexOf("BOOM2") + 5;
      expect(() => view.dispatch({ changes: { from: insideSecond, insert: "z" } })).not.toThrow();
      expect(view.state.doc.toString()).toContain("![BOOM2z alt]");
      expect(hookLogCount(errorSpy)).toBe(1);
    } finally {
      view.destroy();
    }
  });
});

describe("structural block widget identity", () => {
  it("widget identity table: an edit after the last table, one line clear of it, keeps its widget object", async () => {
    const { tableBlockField, TableBlockWidget } = await import(
      "../../src/webview/cm/table/index.js"
    );
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The caret sits at offset 0, on "Top." — clear of every table line.
    const doc = [
      "Top.",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Between.",
      "",
      "| c | d |",
      "| - | - |",
      "| 3 | 4 |",
      "",
      "Edit here.",
      "",
    ].join("\n");
    const st0 = settledState(
      EditorState.create({ doc, extensions: [quollMarkdownLanguage(), tableBlockField] })
    );
    const before = widgetSlots(st0, TableBlockWidget);
    // Precondition: both tables have a widget.
    expect(before.map((s) => s.from)).toEqual([doc.indexOf("| a |"), doc.indexOf("| c |")]);

    const at = doc.indexOf("Edit here.") + 4;
    const st1 = st0.update({ changes: { from: at, insert: "x" } }).state;
    expect(st1.doc.toString()).toContain("Editx here.");
    const after = widgetSlots(st1, TableBlockWidget);
    expect(after.map((s) => s.from)).toEqual(before.map((s) => s.from));
    expect(after[1].widget).toBe(before[1].widget);
  });
});

/** The production table + image fields over the production parser, from one module
 *  graph (the rows below compare widget classes with `instanceof`). */
async function productionBlocks() {
  const { tableBlockField, TableBlockWidget } = await import("../../src/webview/cm/table/index.js");
  const { imageBlockField, ImageBlockWidget } = await import("../../src/webview/cm/image/index.js");
  const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
  const extensions: Extension[] = [quollMarkdownLanguage(), tableBlockField, imageBlockField];
  const create = (doc: string) => settledState(EditorState.create({ doc, extensions }));
  /** `(from, to, widget class)` of every table + image decoration, in order. */
  const shape = (state: EditorState) =>
    [...widgetSlots(state, TableBlockWidget), ...widgetSlots(state, ImageBlockWidget)]
      .sort((a, b) => a.from - b.from)
      .map((s) => [s.from, s.to, s.widget.constructor.name]);
  return {
    tableBlockField,
    TableBlockWidget,
    imageBlockField,
    ImageBlockWidget,
    extensions,
    create,
    shape,
  };
}

const BLOCKS_TAIL = [
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "![pic](https://example.com/p.png)",
  "",
  "Tail paragraph.",
  "",
];

describe("structural blocks: ownership (production fields)", () => {
  const FM_DOC = [
    "---",
    "title: x",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "![pic](https://example.com/p.png)",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  async function ownershipRow(kind: "table" | "image") {
    const p = await productionBlocks();
    const cls = kind === "table" ? p.TableBlockWidget : p.ImageBlockWidget;
    const st0 = p.create(FM_DOC);
    // Precondition: the frontmatter really is recognised (it spans the closer).
    expect(widgetSlots(st0, cls)).toEqual([]);

    const closer = FM_DOC.lastIndexOf("---\n");
    const open = st0.update({ changes: { from: closer, to: closer + 4 } }).state;
    const needle = kind === "table" ? "| a |" : "![pic]";
    expect(widgetSlots(open, cls).map((s) => s.from)).toEqual([
      open.doc.toString().indexOf(needle),
    ]);

    const closed = open.update({ changes: { from: closer, insert: "---\n" } }).state;
    expect(closed.doc.toString()).toBe(FM_DOC);
    expect(widgetSlots(closed, cls)).toEqual([]);
  }

  it("ownership table: a table inside frontmatter has no widget until the closer goes", async () => {
    await ownershipRow("table");
  });

  it("ownership image: an image inside frontmatter has no widget until the closer goes", async () => {
    await ownershipRow("image");
  });
});

describe("structural blocks: frontmatter shift stays bounded (production fields)", () => {
  const FM_SHIFT_DOC = ["---", "title: x", "note: y", "---", "", ...BLOCKS_TAIL].join("\n");
  const NO_FM_DOC = ["Top.", "", "Second.", "", ...BLOCKS_TAIL].join("\n");

  /** The table/image positions the widgets were given, per record. */
  async function positions(state: EditorState) {
    const p = await productionBlocks();
    const t = recordsOf(state.field(p.tableBlockField).records).map(({ from, to, block }) => [
      from,
      to,
      from + block.nodeOffset,
    ]);
    const images = state.field(p.imageBlockField).records;
    const widgets = recordWidgetsOf(images);
    const i = recordsOf(images).map(({ from, to }, n) => [
      from,
      to,
      (widgets[n] as InstanceType<typeof p.ImageBlockWidget>).docFrom,
    ]);
    return { t, i };
  }

  async function shiftRow(doc: string, change: { from: number; to?: number; insert?: string }) {
    const p = await productionBlocks();
    const st0 = p.create(doc);
    // Precondition: both seams built their blocks at mount.
    expect(seam.log.some((s) => s.includes("| a | b |"))).toBe(true);
    expect(seam.log).toContain("pic");
    expect(p.shape(st0)).toHaveLength(2);
    seam.log.length = 0;

    const tr = st0.update({ changes: change });
    const st1 = tr.state;
    expect(requiresFullBoundedRebuild(tr)).toBe(false); // precondition: no full reason
    expect(p.shape(st1)).toHaveLength(2);
    // Bounded rebase: neither block was rebuilt.
    expect(seam.log).toEqual([]);
    // Every widget-visible position equals a fresh full build's.
    const fresh = p.create(st1.doc.toString());
    expect(await positions(st1)).toEqual(await positions(fresh));
    expect(p.shape(st1)).toEqual(p.shape(fresh));
  }

  it("frontmatter body insert: one character inside the body rebases the blocks", async () => {
    await shiftRow(FM_SHIFT_DOC, { from: FM_SHIFT_DOC.indexOf("x\n"), insert: "z" });
  });

  it("frontmatter body delete: one character out of the body rebases the blocks", async () => {
    const at = FM_SHIFT_DOC.indexOf("x\n");
    await shiftRow(FM_SHIFT_DOC, { from: at, to: at + 1 });
  });

  it("no frontmatter offset-0 insert: a keystroke at offset 0 rebases the blocks", async () => {
    await shiftRow(NO_FM_DOC, { from: 0, insert: "z" });
  });
});

describe("structural blocks: an edit outside the viewport (production fields)", () => {
  async function viewportRow(kind: "table" | "image") {
    const p = await productionBlocks();
    const prose: string[] = [];
    for (let i = 0; i < 400; i++) {
      prose.push(`Paragraph ${i} of plain prose between the blocks and the edit.`, "");
    }
    const doc = ["Top.", "", ...BLOCKS_TAIL, ...prose, "Last line."].join("\n");
    const view = mountView(EditorState.create({ doc, extensions: p.extensions }));
    try {
      const records = (): StructuralRecordSet<unknown> =>
        (kind === "table"
          ? view.state.field(p.tableBlockField)
          : view.state.field(p.imageBlockField)
        ).records;
      const blocks = (): unknown[] => recordsOf(records()).map((r) => r.block);
      const widgets = (): unknown[] => recordWidgetsOf(records());
      const beforeRecords = records();
      const beforeWidgets = widgets();
      const before = blocks();
      expect(before).toHaveLength(1); // precondition
      const at = doc.length;
      // Precondition: the edit is beyond the reported viewport and after every block,
      // with at least one line between the last block and the edited line.
      expect(at).toBeGreaterThan(view.viewport.to);
      const lastBlockLine = view.state.doc.lineAt(
        Math.max(...p.shape(view.state).map((s) => Number(s[1])))
      ).number;
      expect(view.state.doc.lineAt(at).number - lastBlockLine).toBeGreaterThan(1);

      view.dispatch({ changes: { from: at, insert: "x" } });
      const after = blocks();
      expect(after).toHaveLength(1);
      expect(after[0]).toBe(before[0]);
      expect(widgets()[0]).toBe(beforeWidgets[0]);
      // A bounded update that reuses every record unchanged returns the previous set.
      expect(records()).toBe(beforeRecords);
      expect(p.shape(view.state)).toEqual(p.shape(p.create(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }

  it("viewport outside table: the table block object is reused and matches a fresh build", async () => {
    await viewportRow("table");
  });

  it("viewport outside image: the image block object is reused and matches a fresh build", async () => {
    await viewportRow("image");
  });
});

describe("structural blocks: reveal (production fields)", () => {
  it("reveal table: a caret on a table line hides its widget, leaving shows the SAME widget", async () => {
    const p = await productionBlocks();
    const doc = ["Top.", "", ...BLOCKS_TAIL].join("\n");
    const st0 = p.create(doc);
    const before = widgetSlots(st0, p.TableBlockWidget);
    expect(before).toHaveLength(1); // precondition: caret at 0 reveals nothing

    const entered = st0.update({ selection: { anchor: before[0].from + 2 } }).state;
    expect(widgetSlots(entered, p.TableBlockWidget)).toEqual([]);
    // The image is on its own line, so it stays rendered.
    expect(widgetSlots(entered, p.ImageBlockWidget)).toHaveLength(1);

    const left = entered.update({ selection: { anchor: 0 } }).state;
    const after = widgetSlots(left, p.TableBlockWidget);
    expect(after.map((s) => s.from)).toEqual([before[0].from]);
    expect(after[0].widget).toBe(before[0].widget);
  });
});

/** Prose long enough that `EditorState.create` publishes a PARTIAL snapshot (its init
 *  parse stops near a 3000-char viewport), followed by `tail`. No fixed offset is relied
 *  on: the partial snapshot is asserted where it matters. */
function beyondInitFrontier(tail: string[]): string {
  const prose: string[] = [];
  for (let i = 0; prose.join("\n").length < 20_000; i++) {
    prose.push(`Paragraph ${i} of plain prose that the initial parse does not reach.`, "");
  }
  return [...prose, ...tail].join("\n");
}

describe("structural blocks beyond the initial parse frontier", () => {
  it("frontier advance: a distant prose edit after an ensureSyntaxTree context advance publishes the blocks", async () => {
    const { tableBlockField, TableBlockWidget } = await import(
      "../../src/webview/cm/table/index.js"
    );
    const { imageBlockField, ImageBlockWidget } = await import(
      "../../src/webview/cm/image/index.js"
    );
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = beyondInitFrontier([
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "![alt](https://example.com/a.png)",
      "",
      "End.",
      "",
    ]);
    // The post-edit reparse has a 20ms wall-clock budget, so the run goes through the
    // starvation-retrying gate (no-bare-unstarved-gate.test.ts); each attempt rebuilds its
    // states from scratch.
    withUnstarvedFrontierState({
      what: "the frontier-advance publication of the table and image blocks",
      observe: (requireUnstarvedFrontier) => {
        const state = EditorState.create({
          doc,
          extensions: [quollMarkdownLanguage(), tableBlockField, imageBlockField],
        });
        // Precondition: the init snapshot is partial and stops before both blocks.
        expect(syntaxTree(state).length).toBeLessThan(doc.indexOf("| a |"));
        expect(widgetSlots(state, TableBlockWidget)).toEqual([]);
        expect(widgetSlots(state, ImageBlockWidget)).toEqual([]);

        // Advance the parse CONTEXT to the end without republishing the snapshot.
        expect(ensureSyntaxTree(state, state.doc.length, 10_000)).not.toBeNull();
        expect(syntaxTree(state).length).toBeLessThan(state.doc.length);

        // A single letter inside the first plain paragraph line, far above both blocks.
        const tr = state.update({ changes: { from: 4, insert: "x" } });
        // Preconditions: the post-edit snapshot is complete, and the structural half of the
        // admission test (`touchesStructuralReparse`) does not fire, so only the frontier
        // term's start-state snapshot clause can send this transaction to a full rebuild.
        requireUnstarvedFrontier(tr.state);
        expect(syntaxTree(tr.state).length).toBe(tr.state.doc.length);
        expect(touchesStructuralReparse(tr)).toBe(false);

        const text = tr.state.doc.toString();
        expect(widgetSlots(tr.state, TableBlockWidget).map((s) => s.from)).toEqual([
          text.indexOf("| a |"),
        ]);
        expect(widgetSlots(tr.state, ImageBlockWidget).map((s) => s.from)).toEqual([
          text.indexOf("![alt]"),
        ]);
        return tr.state;
      },
    });
  });
});

/** The other bounded consumers of the frontier term share the same gap: each target record
 *  is absent over the partial init snapshot, and after the ensureSyntaxTree context advance
 *  plus a distant prose keystroke it must be present and equal to a fully-parsed oracle. */
function expectFrontierAdvancePublishes(
  extensions: Extension[],
  tail: string[],
  needle: string,
  read: (state: EditorState) => unknown[]
): void {
  const doc = beyondInitFrontier(tail);
  withUnstarvedFrontierState({
    what: `the frontier-advance publication of ${needle}`,
    observe: (requireUnstarvedFrontier) => {
      const state = EditorState.create({
        doc,
        extensions: [quollMarkdownLanguage(), ...extensions],
      });
      expect(syntaxTree(state).length).toBeLessThan(doc.indexOf(needle)); // partial snapshot
      expect(read(state)).toEqual([]);
      expect(ensureSyntaxTree(state, state.doc.length, 10_000)).not.toBeNull();
      expect(syntaxTree(state).length).toBeLessThan(state.doc.length); // snapshot/context split
      const tr = state.update({ changes: { from: 4, insert: "x" } });
      requireUnstarvedFrontier(tr.state);
      expect(syntaxTree(tr.state).length).toBe(tr.state.doc.length);
      expect(touchesStructuralReparse(tr)).toBe(false);
      const oracle = read(
        settledState(
          EditorState.create({
            doc: tr.state.doc,
            extensions: [quollMarkdownLanguage(), ...extensions],
          })
        )
      );
      expect(oracle.length).toBeGreaterThan(0); // non-vacuity: the target exists when fully parsed
      expect(read(tr.state)).toEqual(oracle);
      return tr.state;
    },
  });
}

describe("bounded consumers beyond the initial parse frontier", () => {
  it("frontier advance fenced: the collapse record of a long fence is published", () => {
    const body = Array.from({ length: 30 }, (_, i) => `code line ${i}`);
    expectFrontierAdvancePublishes(
      [fencedCodeCollapseField],
      ["```txt", ...body, "```", "", "End.", ""],
      "```txt",
      (st) =>
        st.field(fencedCodeCollapseField).blocks.map((b) => [b.blockFrom, b.blockTo, b.hiddenCount])
    );
  });

  it("frontier advance fold: the heading gutter marker is published", () => {
    expectFrontierAdvancePublishes(
      [headingFoldGutterLineClass],
      ["## Late heading", "", "Body under it.", "", "End.", ""],
      "## Late heading",
      (st) => {
        const out: Array<[number, string]> = [];
        st.field(headingFoldGutterLineClass).between(0, st.doc.length, (from, _to, marker) => {
          out.push([from, marker.elementClass]);
        });
        return out;
      }
    );
  });

  it("frontier advance callout: the callout marker conceal record is published", () => {
    expectFrontierAdvancePublishes(
      [calloutMarkerConcealField],
      ["> [!NOTE]", "> callout body", "", "End.", ""],
      "> [!NOTE]",
      (st) =>
        st
          .field(calloutMarkerConcealField)
          .records.map((r) => [r.markerFrom, r.markerTo, r.blockTo])
    );
  });
});

// ---------------------------------------------------------------------------------------
// Toy spec: the contract arms exercised directly through `structuralBlockWidgets`.
// A toy block is a fenced code block snapped to whole lines.

interface ToyBlock {
  readonly text: string;
}

class ToyWidget extends QuollWidget {
  readonly widgetName = "ToyBlockWidget";
  constructor(
    readonly at: number,
    readonly text: string
  ) {
    super();
  }
  protected render(): HTMLElement {
    const el = document.createElement("div");
    el.textContent = this.text;
    return el;
  }
  protected sameAs(other: QuollWidget): boolean {
    return other instanceof ToyWidget && other.at === this.at && other.text === this.text;
  }
}

interface ToyOptions {
  /** Runs after the default block is computed; may throw, transform or veto it. */
  build?: (built: BuiltBlock<ToyBlock>) => BuiltBlock<ToyBlock> | null;
  /** Runs before the widget is made; may throw. */
  widget?: (block: ToyBlock, from: number) => void;
}

interface Toy {
  field: StateField<StructuralBlockState<ToyBlock>>;
  /** The block start of every hook call, in call order. */
  calls: { build: number[]; widget: number[] };
}

function toy(opts: ToyOptions = {}): Toy {
  const calls = { build: [] as number[], widget: [] as number[] };
  const spec: StructuralBlockSpec<ToyBlock> = {
    name: "toy",
    node: "FencedCode",
    build(state, node) {
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      calls.build.push(from);
      const built: BuiltBlock<ToyBlock> = { from, to, block: { text: state.sliceDoc(from, to) } };
      return opts.build ? opts.build(built) : built;
    },
    widget(block, from) {
      calls.widget.push(from);
      opts.widget?.(block, from);
      return new ToyWidget(from, block.text);
    },
  };
  return { field: structuralBlockWidgets(spec), calls };
}

function toyState(doc: string, t: Toy, extra: Extension[] = []): EditorState {
  const state = settledState(
    EditorState.create({ doc, extensions: [quollMarkdownLanguage(), t.field, ...extra] })
  );
  t.calls.build.length = 0;
  t.calls.widget.length = 0;
  return state;
}

function ranges(state: EditorState, t: Toy): Array<[number, number]> {
  return recordsOf(state.field(t.field).records).map((r) => [r.from, r.to]);
}

/** The FencedCode node set of a fully-parsed state, line-snapped, in order. */
function fencedRanges(state: EditorState): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") {
        return undefined;
      }
      out.push([state.doc.lineAt(node.from).from, state.doc.lineAt(node.to).to]);
      return false;
    },
  });
  return out;
}

function fence(body: string[]): string[] {
  return ["```", ...body, "```"];
}

const TOY_DOC = [
  "Intro paragraph.",
  "",
  ...fence(["alpha"]),
  "",
  "Middle paragraph.",
  "",
  ...fence(["beta BOOM"]),
  "",
  ...fence(["gamma"]),
  "",
  "Tail paragraph.",
  "",
  "Last line.",
  "",
].join("\n");

describe("structural block contract (toy spec)", () => {
  it("toy full: records are the spec's node set in order, and recordAt finds them", () => {
    const t = toy();
    const state = toyState(TOY_DOC, t);
    const expected = fencedRanges(state);
    expect(expected).toHaveLength(3); // precondition
    expect(ranges(state, t)).toEqual(expected);
    const records = state.field(t.field).records;
    const list = recordsOf(records);
    for (const r of list) {
      const hit = recordAt(records, r.from);
      expect(hit).toEqual(r);
      expect(hit?.block).toBe(r.block);
    }
    expect(recordAt(records, 0)).toBeUndefined();
    expect(recordAt(records, list[0].from + 1)).toBeUndefined();
    expect(recordAt(records, list[2].to + 1)).toBeUndefined();
    expect(recordAt(Decoration.none, 0)).toBeUndefined();
    expect(widgetSlots(state, ToyWidget).map((s) => s.from)).toEqual(expected.map((e) => e[0]));
  });

  it("toy build throws: that block stays raw, its siblings render, one log per arm", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({
      build: (b) => {
        if (b.block.text.includes("BOOM")) {
          throw new Error("toy build");
        }
        return b;
      },
    });
    const state = toyState(TOY_DOC, t);
    const all = fencedRanges(state);
    const boom = all[1];
    expect(ranges(state, t)).toEqual([all[0], all[2]]);
    expect(widgetSlots(state, ToyWidget).map((s) => s.from)).toEqual([all[0][0], all[2][0]]);
    // A second failing build (full rebuild after a structural edit) logs nothing more.
    const next = state.update({ changes: { from: 0, insert: "\n" } }).state;
    expect(ranges(next, t).map((r) => r[0])).not.toContain(boom[0] + 1);
    expect(hookLogCount(spy)).toBe(1);
    expect(spy.mock.calls.find((c) => String(c[0]).startsWith(HOOK_LOG))?.[1]).toEqual({
      name: "toy",
      arm: "build",
      errKind: "object",
    });
  });

  it("toy widget throws: that block stays raw, its siblings render, one log per arm", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({
      widget: (b) => {
        if (b.text.includes("BOOM")) {
          throw new Error("toy widget");
        }
      },
    });
    const state = toyState(TOY_DOC, t);
    const all = fencedRanges(state);
    expect(ranges(state, t)).toEqual([all[0], all[2]]);
    expect(widgetSlots(state, ToyWidget).map((s) => s.from)).toEqual([all[0][0], all[2][0]]);
    state.update({ changes: { from: 0, insert: "\n" } });
    expect(hookLogCount(spy)).toBe(1);
    expect(spy.mock.calls.find((c) => String(c[0]).startsWith(HOOK_LOG))?.[1]).toEqual({
      name: "toy",
      arm: "widget",
      errKind: "object",
    });
  });

  it("toy ownership: frontmatter owns its blocks, invalid ranges are dropped, a body shift stays bounded", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({
      build: (b) => {
        if (b.block.text.includes("NARROW")) {
          return { ...b, from: b.from + 4 }; // does not contain its node
        }
        if (b.block.text.includes("EMPTY")) {
          return { ...b, to: b.from }; // from >= to
        }
        return b;
      },
    });
    const doc = [
      "---",
      "title: x",
      "note: y",
      ...fence(["inside"]),
      "---",
      "",
      ...fence(["NARROW"]),
      "",
      ...fence(["EMPTY"]),
      "",
      ...fence(["after"]),
      "",
    ].join("\n");
    const state = toyState(doc, t);
    const after = doc.indexOf("```\nafter");
    expect(ranges(state, t).map((r) => r[0])).toEqual([after]);
    expect(hookLogCount(spy)).toBe(1);
    expect(spy.mock.calls.find((c) => String(c[0]).startsWith(HOOK_LOG))?.[1]).toEqual({
      name: "toy",
      arm: "build",
      errKind: "invalid-range",
    });

    // A rigid shift inside the frontmatter body: bounded, the block is rebased, not rebuilt.
    const shiftTr = state.update({ changes: { from: doc.indexOf("x\n"), insert: "z" } });
    expect(requiresFullBoundedRebuild(shiftTr)).toBe(false); // precondition
    expect(ranges(shiftTr.state, t).map((r) => r[0])).toEqual([after + 1]);
    expect(t.calls.build).not.toContain(after + 1);

    // Deleting the closer dissolves the frontmatter: the inner block appears.
    const closer = doc.indexOf("---\n\n");
    const open = state.update({ changes: { from: closer, to: closer + 4 } }).state;
    const inner = open.doc.toString().indexOf("```\ninside");
    expect(ranges(open, t).map((r) => r[0])).toContain(inner);
    // Re-adding it takes the block away again.
    const closed = open.update({ changes: { from: closer, insert: "---\n" } }).state;
    expect(ranges(closed, t).map((r) => r[0])).toEqual([after]);
  });
});

describe("structural block contract preconditions (toy spec)", () => {
  it("toy overlap dropped: of two overlapping blocks the later one goes, its sibling survives", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const betaEnd = TOY_DOC.indexOf("```\n\n```\ngamma") + 3;
    const t = toy({
      // alpha's block reaches over beta: whole lines, contains its node, overlaps beta.
      build: (b) => (b.block.text.includes("alpha") ? { ...b, to: betaEnd } : b),
    });
    const state = toyState(TOY_DOC, t);
    const all = fencedRanges(state);
    expect(all).toHaveLength(3); // precondition
    expect(state.doc.lineAt(betaEnd).to).toBe(betaEnd); // precondition: whole lines
    expect(ranges(state, t)).toEqual([[all[0][0], betaEnd], all[2]]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([
      "[quoll] structural blocks overlap; dropping the later one",
      { name: "toy", arm: "overlap" },
    ]);
  });

  it("toy non-aligned dropped: a block that does not end at a line end gets no record", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({
      // alpha's block ends 3 characters into "Middle paragraph.": contains its node, in
      // bounds, from < to — only the whole-lines precondition rejects it.
      build: (b) => (b.block.text.includes("alpha") ? { ...b, to: b.to + 3 } : b),
    });
    const state = toyState(TOY_DOC, t);
    const all = fencedRanges(state);
    expect(all).toHaveLength(3); // precondition
    expect(ranges(state, t)).toEqual([all[1], all[2]]);
    expect(hookLogCount(spy)).toBe(1);
    expect(spy.mock.calls.find((c) => String(c[0]).startsWith(HOOK_LOG))?.[1]).toEqual({
      name: "toy",
      arm: "build",
      errKind: "invalid-range",
    });
  });

  // One row per `validRange` conjunct the rows above leave unpinned. Each drops alpha's
  // block (its siblings survive) on create AND on a bounded update that re-walks alpha, and
  // logs `invalid-range` exactly once without throwing out of `StateField.update`.
  const ALPHA_CLOSER = "```\nalpha".length; // offset of alpha's body line end from its block start
  it.each([
    ["from < 0", (b: BuiltBlock<ToyBlock>) => ({ ...b, from: -1 })],
    // +2: the update's 1-char insert grows the doc to length + 1, so +1 would turn valid.
    ["to past the document end", (b: BuiltBlock<ToyBlock>) => ({ ...b, to: TOY_DOC.length + 2 })],
    [
      // from - 2 is the end of "Intro paragraph." — before the node, but not a line start.
      "from mid-line (to at a line end)",
      (b: BuiltBlock<ToyBlock>) => ({ ...b, from: b.from - 2 }),
    ],
    [
      "to at a line end before the node end",
      (b: BuiltBlock<ToyBlock>) => ({ ...b, to: b.from + ALPHA_CLOSER }),
    ],
  ])("toy invalid range (%s): dropped on create and on a bounded update", (_name, mutate) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({ build: (b) => (b.block.text.includes("alpha") ? mutate(b) : b) });
    const state = toyState(TOY_DOC, t);
    const all = fencedRanges(state);
    expect(all).toHaveLength(3); // precondition
    expect(ranges(state, t)).toEqual([all[1], all[2]]);
    expect(hookLogCount(spy)).toBe(1);
    expect(spy.mock.calls.find((c) => String(c[0]).startsWith(HOOK_LOG))?.[1]).toEqual({
      name: "toy",
      arm: "build",
      errKind: "invalid-range",
    });

    // An edit inside alpha's body: bounded, and the span re-walks (re-validates) alpha.
    const tr = state.update({ changes: { from: TOY_DOC.indexOf("alpha"), insert: "x" } });
    expect(requiresFullBoundedRebuild(tr)).toBe(false); // precondition
    expect(t.calls.build).toContain(all[0][0]); // alpha was re-walked
    expect(ranges(tr.state, t)).toEqual(fencedRanges(tr.state).slice(1));
    expect(hookLogCount(spy)).toBe(1);
  });

  it("brand pin: one field's records are not another field's record set", () => {
    // Type-level only (a tsc program covers this file): the brand on StructuralRecordSet
    // makes the assignment below a compile error, so recordAt infers the right payload.
    const assign = (state: EditorState, field: typeof imageBlockField) => {
      // @ts-expect-error — image records are not a StructuralRecordSet<TableBlock>
      const tables: StructuralRecordSet<TableBlock> = state.field(field).records;
      return tables;
    };
    expect(typeof assign).toBe("function");
  });
});

describe("structural block contract updates (toy spec)", () => {
  function fromOf(state: EditorState, needle: string): number {
    const i = state.doc.toString().indexOf(needle);
    expect(i).toBeGreaterThanOrEqual(0); // precondition: the fixture carries the needle
    return state.doc.lineAt(i).from;
  }

  it("toy bounded update: an edit clear of a block reuses its record; an edit inside rebuilds only it", () => {
    const t = toy();
    const state = toyState(TOY_DOC, t);
    const beforeSet = state.field(t.field).records;
    const before = recordsOf(beforeSet);
    expect(before).toHaveLength(3); // precondition

    const clearTr = state.update({
      changes: { from: state.doc.toString().indexOf("Tail paragraph.") + 4, insert: "x" },
    });
    expect(requiresFullBoundedRebuild(clearTr)).toBe(false); // precondition: bounded path
    // Every record reused unchanged and none added: the previous set itself.
    expect(clearTr.state.field(t.field).records).toBe(beforeSet);
    expect(t.calls.build).toEqual([]);

    // Inside the LAST block, so no other block moves (a moved block is rebased: "toy rebase").
    const gamma = before[2].from;
    const insideTr = state.update({
      changes: { from: state.doc.toString().indexOf("gamma") + 2, insert: "x" },
    });
    expect(requiresFullBoundedRebuild(insideTr)).toBe(false); // precondition: bounded path
    const insideSet = insideTr.state.field(t.field).records;
    const inside = recordsOf(insideSet);
    expect(t.calls.build).toEqual([gamma]);
    expect(inside[2].block).not.toBe(before[2].block);
    expect(inside[2].block.text).toContain("gaxmma");
    expect(inside[0].block).toBe(before[0].block);
    expect(inside[1].block).toBe(before[1].block);
    const beforeWidgets = recordWidgetsOf(beforeSet);
    const insideWidgets = recordWidgetsOf(insideSet);
    expect(insideWidgets[0]).toBe(beforeWidgets[0]);
    expect(insideWidgets[1]).toBe(beforeWidgets[1]);
  });

  it("toy rebase: an insertion before a block mints a shifted record without rebuilding it", () => {
    const t = toy();
    const state = toyState(TOY_DOC, t);
    const beforeSet = state.field(t.field).records;
    const before = recordsOf(beforeSet);
    const tr = state.update({ changes: { from: 4, insert: "x" } });
    expect(requiresFullBoundedRebuild(tr)).toBe(false); // precondition: bounded path
    const afterSet = tr.state.field(t.field).records;
    const after = recordsOf(afterSet);
    expect(after.map((r) => [r.from, r.to])).toEqual(before.map((r) => [r.from + 1, r.to + 1]));
    // The shifted record keeps the SAME payload object; only its widget is re-minted.
    after.forEach((r, i) => {
      expect(r.block).toBe(before[i].block);
    });
    const beforeWidgets = recordWidgetsOf(beforeSet);
    recordWidgetsOf(afterSet).forEach((w, i) => {
      expect(w).not.toBe(beforeWidgets[i]);
    });
    expect(t.calls.build).toEqual([]);
    expect(t.calls.widget).toEqual(before.map((r) => r.from + 1));
    expect(widgetSlots(tr.state, ToyWidget).map((s) => (s.widget as ToyWidget).at)).toEqual(
      before.map((r) => r.from + 1)
    );
  });

  it("toy widget throws on rebase: the dispatch succeeds and the rebased block is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gamma = TOY_DOC.indexOf("```\ngamma");
    const t = toy({
      widget: (_b, from) => {
        if (from === gamma + 1) {
          throw new Error("toy widget on rebase");
        }
      },
    });
    const state = toyState(TOY_DOC, t);
    expect(ranges(state, t).map((r) => r[0])).toContain(gamma); // precondition: first build ok
    const tr = state.update({ changes: { from: 4, insert: "x" } });
    expect(requiresFullBoundedRebuild(tr)).toBe(false); // precondition: bounded path
    expect(t.calls.build).toEqual([]);
    expect(t.calls.widget).toContain(gamma + 1);
    const after = ranges(tr.state, t).map((r) => r[0]);
    expect(after).toHaveLength(2);
    expect(after).not.toContain(gamma + 1);
    expect(hookLogCount(spy)).toBe(1);
  });

  it("toy dedupe: two distant edits inside one long block call each hook once for it", () => {
    const t = toy();
    const body = Array.from({ length: 12 }, (_, i) => `code line ${i}`);
    const doc = ["Intro.", "", ...fence(body), "", "Tail.", ""].join("\n");
    const state = toyState(doc, t);
    const blockFrom = fromOf(state, "```");
    const text = state.doc.toString();
    const tr = state.update({
      changes: [
        { from: text.indexOf("code line 1") + 2, insert: "x" },
        { from: text.indexOf("code line 9") + 2, insert: "y" },
      ],
    });
    expect(requiresFullBoundedRebuild(tr)).toBe(false); // precondition: bounded path
    expect(t.calls.build).toEqual([blockFrom]);
    expect(t.calls.widget).toEqual([blockFrom]);
    expect(ranges(tr.state, t)).toEqual(fencedRanges(tr.state));
  });

  it("toy tree identity: a republished tree with no doc change publishes a block past the old frontier", () => {
    const t = toy();
    const doc = beyondInitFrontier([...fence(["late"]), "", "End.", ""]);
    const state = EditorState.create({ doc, extensions: [quollMarkdownLanguage(), t.field] });
    const late = doc.indexOf("```\nlate");
    expect(syntaxTree(state).length).toBeLessThan(late); // precondition: partial snapshot
    expect(ranges(state, t)).toEqual([]);
    expect(ensureSyntaxTree(state, state.doc.length, 10_000)).not.toBeNull();
    const next = state.update({}).state;
    expect(syntaxTree(next)).not.toBe(syntaxTree(state)); // precondition: tree republished
    expect(ranges(next, t).map((r) => r[0])).toEqual([late]);
  });

  it("toy branching: transactions and states sharing the field keep independent records", () => {
    const t = toy();
    const state = toyState(TOY_DOC, t);
    const base = state.field(t.field).records;
    const text = state.doc.toString();
    // Two branches: one edits inside the last block, the other the prose after it.
    const a = state.update({ changes: { from: text.indexOf("gamma") + 1, insert: "x" } }).state;
    const b = state.update({ changes: { from: text.indexOf("Tail") + 1, insert: "y" } }).state;
    expect(state.field(t.field).records).toBe(base);
    const baseList = recordsOf(base);
    const ra = recordsOf(a.field(t.field).records);
    const rb = recordsOf(b.field(t.field).records);
    expect(ra[2].block).not.toBe(baseList[2].block);
    expect(ra[0].block).toBe(baseList[0].block);
    rb.forEach((r, i) => {
      expect(r.block).toBe(baseList[i].block);
    });
    expect(b.field(t.field).records).toBe(base);
    expect(ra[2].block.text).toContain("gxamma");
    expect(rb[2].block.text).not.toContain("gxamma");
    expect(recordsOf(state.field(t.field).records)[2].block.text).not.toContain("gxamma");

    // A second state built with the same field instance is untouched by updates to the first.
    const other = toyState(["Other.", "", ...fence(["delta"]), ""].join("\n"), t);
    const otherRecords = other.field(t.field).records;
    state.update({ changes: { from: 0, insert: "\n\n" } });
    expect(other.field(t.field).records).toBe(otherRecords);
    expect(recordsOf(otherRecords).map((r) => r.block.text)).toEqual(["```\ndelta\n```"]);
  });

  it("toy seeded oracle: after each of 20 seeded edits the records equal a fresh full build", () => {
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const inserts = ["x", " ", "\n", "`", "```\n", "\n\n", "ab"];
    const t = toy();
    let state = toyState(TOY_DOC, t);
    for (let i = 0; i < 20; i++) {
      const len = state.doc.length;
      const from = rand(len + 1);
      const spec =
        rand(3) === 0 && from < len
          ? { from, to: Math.min(len, from + 1 + rand(4)) }
          : { from, insert: inserts[rand(inserts.length)] };
      state = state.update({ changes: spec }).state;
      const got = ranges(state, t);
      const sorted = [...got].sort((x, y) => x[0] - y[0]);
      expect(got).toEqual(sorted);
      const oracle = toyState(state.doc.toString(), toy());
      expect(got).toEqual(fencedRanges(oracle));
    }
  });
});

describe("structural block reveal (toy spec)", () => {
  it("reveal: a caret on a block line hides its widget, leaving shows the SAME widget object", () => {
    const t = toy();
    const state = toyState(TOY_DOC, t);
    const before = widgetSlots(state, ToyWidget);
    expect(before).toHaveLength(3); // precondition: caret at 0 reveals nothing
    const alpha = before[0];
    // No record meets the selection: the selection-filtered view IS the record set.
    expect(state.field(t.field).decorations).toBe(state.field(t.field).records);
    // A caret move between two prose lines changes no verdict: the field value itself.
    const prose = state.update({
      selection: { anchor: TOY_DOC.indexOf("Middle paragraph.") },
    }).state;
    expect(prose.field(t.field)).toBe(state.field(t.field));

    const entered = state.update({ selection: { anchor: alpha.from + 1 } }).state;
    expect(widgetSlots(entered, ToyWidget).map((s) => s.from)).toEqual([
      before[1].from,
      before[2].from,
    ]);
    // The record is kept while its decoration is hidden.
    expect(entered.field(t.field).records).toBe(state.field(t.field).records);

    const left = entered.update({ selection: { anchor: 0 } }).state;
    const after = widgetSlots(left, ToyWidget);
    expect(after.map((s) => s.from)).toEqual(before.map((s) => s.from));
    after.forEach((s, i) => {
      expect(s.widget).toBe(before[i].widget);
    });
    expect(t.calls.widget).toEqual([]);

    // A caret move that keeps the same line spans returns the field value itself.
    const same = left.update({ selection: { anchor: 1 } }).state;
    expect(same.field(t.field)).toBe(left.field(t.field));
  });
});

// ---------------------------------------------------------------------------------------
// Frontier pin: the upstream leaf-completeness behaviour the contract relies on (no
// "settled" rule exists because of it). A partial @lezer/markdown tree holds a leaf block
// whole or not at all; a block the parser has not reached is simply absent. If a future
// parser cut a leaf block at `stoppedAt`, these rows go red.

const productionParser = quollMarkdownLanguage().language.parser;

function parseTo(doc: string, stop: number | null, fragments: readonly TreeFragment[] = []): Tree {
  const parse = productionParser.startParse(doc, fragments);
  if (stop !== null) {
    parse.stopAt(stop);
  }
  for (;;) {
    const tree = parse.advance();
    if (tree !== null) {
      return tree;
    }
  }
}

function nodeRanges(tree: Tree, name: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === name) {
        out.push([node.from, node.to]);
      }
    },
  });
  return out;
}

/** For every stop strictly inside the complete target, the partial tree either lacks the
 *  target or holds it with its complete range. Returns the number of stops checked. */
function expectLeafWholeOrAbsent(
  doc: string,
  name: string,
  fragments: () => readonly TreeFragment[]
): number {
  const complete = nodeRanges(parseTo(doc, null), name);
  expect(complete).toHaveLength(1); // non-vacuity: the complete target exists
  const [from, to] = complete[0];
  let checked = 0;
  for (let p = from + 1; p < to; p++) {
    const partial = nodeRanges(parseTo(doc, p, fragments()), name).filter(
      ([f, t]) => f < to && t > from
    );
    if (partial.length > 0) {
      expect(partial).toEqual([[from, to]]);
    }
    checked++;
  }
  expect(checked).toBeGreaterThan(0); // non-vacuity: at least one stop inside the target
  return checked;
}

function expectIncremental(prev: string, edit: { from: number; insert: string }, name: string) {
  const next = prev.slice(0, edit.from) + edit.insert + prev.slice(edit.from);
  const prevTree = parseTo(prev, null);
  const fragments = () =>
    TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
      { fromA: edit.from, toA: edit.from, fromB: edit.from, toB: edit.from + edit.insert.length },
    ]);
  expect(fragments().length).toBeGreaterThan(0); // non-vacuity: reusable fragments supplied
  expectLeafWholeOrAbsent(next, name, fragments);
}

const PIN_PROSE = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i} of plain prose before and after the target block.`
);

describe("frontier pin: a partial parse holds a leaf block whole or not at all", () => {
  it("frontier pin table: fresh and incremental parses never cut a Table", () => {
    const doc = [
      ...PIN_PROSE.slice(0, 3).flatMap((l) => [l, ""]),
      "| head a | head b | head c |",
      "| --- | :-: | --: |",
      ...Array.from({ length: 8 }, (_, i) => `| r${i}a | r${i}b | r${i}c |`),
      "",
      ...PIN_PROSE.slice(3).flatMap((l) => [l, ""]),
    ].join("\n");
    expectLeafWholeOrAbsent(doc, "Table", () => []);
    expectIncremental(doc, { from: 4, insert: "x" }, "Table");
    expectIncremental(doc, { from: doc.indexOf("r3b") + 1, insert: "x" }, "Table");
  });

  it("frontier pin image: fresh and incremental parses never cut an Image", () => {
    const alt = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    const doc = [
      ...PIN_PROSE.slice(0, 3).flatMap((l) => [l, ""]),
      `![${alt}](https://example.com/picture.png "a title")`,
      "",
      ...PIN_PROSE.slice(3).flatMap((l) => [l, ""]),
    ].join("\n");
    expectLeafWholeOrAbsent(doc, "Image", () => []);
    expectIncremental(doc, { from: 4, insert: "x" }, "Image");
    expectIncremental(doc, { from: doc.indexOf("word5") + 2, insert: "x" }, "Image");
  });
});
