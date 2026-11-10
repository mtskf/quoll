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
import { ensureSyntaxTree, foldable, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, type Extension, type StateField } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import {
  recordAt,
  type StructuralBlock,
  type StructuralBlockSpec,
  type StructuralBlockState,
  structuralBlockWidgets,
} from "../../src/webview/cm/structural-blocks.js";
import {
  requiresFullBoundedRebuild,
  touchesStructuralReparse,
} from "../../src/webview/cm/structural-guard.js";
import { QuollWidget } from "../../src/webview/cm/widget-base.js";
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
    // Preconditions: the post-edit snapshot is complete, and HEAD's admission test sends
    // this transaction down the bounded path.
    expect(syntaxTree(tr.state).length).toBe(tr.state.doc.length);
    expect(touchesStructuralReparse(tr)).toBe(false);
    expect(syntaxTreeAvailable(tr.state, tr.state.doc.length)).toBe(true);

    const text = tr.state.doc.toString();
    expect(widgetSlots(tr.state, TableBlockWidget).map((s) => s.from)).toEqual([
      text.indexOf("| a |"),
    ]);
    expect(widgetSlots(tr.state, ImageBlockWidget).map((s) => s.from)).toEqual([
      text.indexOf("![alt]"),
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// Toy spec: the contract arms exercised directly through `structuralBlockWidgets`.
// A toy block is a fenced code block snapped to whole lines.

interface ToyBlock extends StructuralBlock {
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
  build?: (block: ToyBlock) => ToyBlock | null;
  /** Runs before the widget is made; may throw. */
  widget?: (block: ToyBlock) => void;
}

interface Toy {
  field: StateField<StructuralBlockState<ToyBlock>>;
  /** `block.from` of every hook call, in call order. */
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
      const block: ToyBlock = { from, to, text: state.sliceDoc(from, to) };
      return opts.build ? opts.build(block) : block;
    },
    widget(block) {
      calls.widget.push(block.from);
      opts.widget?.(block);
      return new ToyWidget(block.from, block.text);
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
  return state.field(t.field).records.map((r) => [r.block.from, r.block.to]);
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
    for (const r of records) {
      expect(recordAt(records, r.block.from)).toBe(r);
    }
    expect(recordAt(records, 0)).toBeUndefined();
    expect(recordAt(records, records[0].block.from + 1)).toBeUndefined();
    expect(recordAt(records, records[2].block.to + 1)).toBeUndefined();
    expect(recordAt([], 0)).toBeUndefined();
    expect(widgetSlots(state, ToyWidget).map((s) => s.from)).toEqual(expected.map((e) => e[0]));
  });

  it("toy build throws: that block stays raw, its siblings render, one log per arm", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = toy({
      build: (b) => {
        if (b.text.includes("BOOM")) {
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
        if (b.text.includes("NARROW")) {
          return { ...b, from: b.from + 4 }; // does not contain its node
        }
        if (b.text.includes("EMPTY")) {
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
