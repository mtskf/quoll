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
import { foldable } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settledState } from "./helpers/settled-state.js";
import { settledMount } from "./helpers/settled-view.js";

// One switch for both throwing seams. A mock only throws while `armed` is true, so the
// fields' `create` (which already calls both seams) never throws at mount.
const seam = vi.hoisted(() => ({ armed: false, armedCalls: 0 }));

// The specifier the table block field imports `parseTable` from.
vi.mock("../../src/markdown/table/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/markdown/table/index.js")>();
  return {
    ...real,
    parseTable: (source: string, from: number, to: number) => {
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
