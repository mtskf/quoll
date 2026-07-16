// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type SelectionRange,
  StateField,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  initialRevealState,
  nextRevealState,
  type RevealState,
  revealFrontmatterAt,
  revealFrontmatterEffect,
} from "../../../src/webview/cm/frontmatter/reveal-state.js";
import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";

const FM = "---\ntitle: x\n---\n\n# Body\n";
const TO = "---\ntitle: x\n---".length; // 16

// Throwaway field running the pure reducer so real transactions (with a real
// ChangeSet for provenance) drive it. The writable compartment provides BOTH
// EditorView.editable AND EditorState.readOnly (mirroring production) so the
// write-revoke + readOnly-authority tests can flip each independently.
const writableComp = new Compartment();
const probe = StateField.define<RevealState>({
  create: (s) => initialRevealState(s),
  update: (prev, tr) => nextRevealState(prev, tr),
});

function start(
  doc: string,
  selection?: EditorSelection | SelectionRange,
  editable = true
): EditorState {
  return EditorState.create({
    doc,
    selection: selection ?? EditorSelection.cursor(doc.length),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      writableComp.of([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
      probe,
    ],
  });
}

describe("reveal-state — initial + block-on-open", () => {
  it("frontmatter starts collapsed regardless of caret at 0", () => {
    const s = start(FM, EditorSelection.cursor(0));
    expect(s.field(probe)).toEqual({
      kind: "collapsed",
      span: expect.objectContaining({ to: TO }),
    });
  });
  it("no frontmatter → absent", () => {
    expect(start("# just a heading\n").field(probe)).toEqual({ kind: "absent" });
  });
});

describe("reveal-state — single-dispatch reveal + re-collapse", () => {
  it("effect + selection-in-span (one transaction) → revealed", () => {
    let s = start(FM, EditorSelection.cursor(TO + 1));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe)).toEqual({ kind: "revealed", span: expect.objectContaining({ to: TO }) });
  });
  it("effect with selection OUTSIDE the span does not reveal", () => {
    let s = start(FM, EditorSelection.cursor(TO + 1));
    s = s.update({
      effects: revealFrontmatterEffect.of(null),
      selection: { anchor: s.doc.length },
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("revealed → collapsed when caret moves to the line below", () => {
    let s = start(FM, EditorSelection.cursor(TO + 1));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
    s = s.update({ selection: { anchor: TO + 2 } }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("revealed stays revealed while caret is inside (incl. the closer at TO)", () => {
    let s = start(FM, EditorSelection.cursor(TO + 1));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    s = s.update({ selection: { anchor: TO } }).state;
    expect(s.field(probe).kind).toBe("revealed");
  });
});

describe("reveal-state — provenance", () => {
  function reveal(s0: EditorState): EditorState {
    return s0.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
  }
  it("delete-all → paste (two transactions) ends collapsed", () => {
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    expect(s.field(probe).kind).toBe("revealed");
    s = s.update({ changes: { from: 0, to: s.doc.length, insert: "" } }).state;
    expect(s.field(probe).kind).toBe("absent");
    s = s.update({ changes: { from: 0, insert: FM } }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("one-transaction whole-replace paste ends collapsed (caret pinned in span → break is solely envelope coverage)", () => {
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    // Pin the caret INSIDE the new span (anchor 6) so the carry's caret-in-span
    // sub-condition is satisfied; the ONLY thing forcing collapse is
    // changeCoversRange — without this the test could pass for the wrong reason
    // (mapped caret falling outside the span). (Codex re-review #2.)
    s = s.update({
      changes: { from: 0, to: s.doc.length, insert: "---\ntitle: y\n---\n\n# New\n" },
      selection: { anchor: 6 },
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("closer-break → next-transaction-restore ends collapsed", () => {
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    // Closer "---" at [13,16); delete index 15 → "--" breaks the fence.
    s = s.update({ changes: { from: 15, to: 16, insert: "" } }).state;
    expect(s.field(probe).kind).toBe("absent");
    s = s.update({ changes: { from: 15, insert: "-" } }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("an edit inside the body (caret stays in span) carries the reveal", () => {
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    s = s.update({ changes: { from: 6, insert: "z" }, selection: { anchor: 7 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
  });
  it("carry needs the caret to remain in the span (Codex #4)", () => {
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    // Edit inside the body but the SAME transaction parks the caret far below.
    s = s.update({ changes: { from: 6, insert: "z" }, selection: { anchor: s.doc.length } }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("whitespace edits to BOTH fences in one tx still carry (envelope counter-test)", () => {
    // Opener "---"→"--- " (insert at 3) and closer "---"→"--- " (insert at 16 in the
    // resulting doc is fiddly; do it as two changes in old coords: at 3 and at 16).
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    s = s.update({
      changes: [
        { from: 3, insert: " " },
        { from: 16, insert: " " },
      ],
      selection: { anchor: 7 },
    }).state;
    // Both edits start at offset > 0, so the envelope does NOT reach span.from=0
    // → no break; the span is still valid → carry.
    expect(s.field(probe).kind).toBe("revealed");
  });
  it("two DISJOINT edits bracketing the span (touching from=0 AND below the closer) carry — per-range, NOT union envelope", () => {
    // changeCoversRange must check coverage PER changed range, not via a union
    // envelope. Change 1 is a fence-preserving replace of the opener `---`→`---`
    // (fromA=0, toA=3 — leaves a valid leading fence), change 2 inserts BELOW the
    // closer line (fromA=TO+1). The UNION envelope (minFrom=0, maxTo=TO+1) WOULD
    // cover [0, TO] and collapse the reveal; but no SINGLE change rewrites the
    // span interior, so the still-valid reveal must survive. Caret pinned in-span
    // so the only thing that could break it is changeCoversRange.
    let s = reveal(start(FM, EditorSelection.cursor(6)));
    s = s.update({
      changes: [
        { from: 0, to: 3, insert: "---" }, // opener replaced by identical fence
        { from: TO + 1, insert: "more\n" }, // a new line below the closer
      ],
      selection: { anchor: 6 },
    }).state;
    expect(s.field(probe).kind).toBe("revealed");
  });
});

describe("reveal-state — host reseed + write access", () => {
  it("a host reseed mid-reveal (still editable, caret in span) PRESERVES revealed", () => {
    let s = start(FM, EditorSelection.cursor(6));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
    s = s.update({
      annotations: hostDocumentReseed.of(true),
      changes: { from: 0, to: s.doc.length, insert: "---\ntitle: x2\n---\n\n# Body\n" },
      selection: { anchor: 6 },
    }).state;
    expect(s.field(probe).kind).toBe("revealed");
  });
  it("revoking editable while revealed collapses (reconfigure, no doc change)", () => {
    let s = start(FM, EditorSelection.cursor(6));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
    s = s.update({
      effects: writableComp.reconfigure([
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ]),
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("setting EditorState.readOnly while still editable=true collapses (readOnly is the authority — Codex #4)", () => {
    let s = start(FM, EditorSelection.cursor(6));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
    // Pathological combo readOnly=true + editable=true: the writable invariant
    // must still collapse because EditorState.readOnly is CodeMirror's canonical
    // edit authority.
    s = s.update({
      effects: writableComp.reconfigure([
        EditorView.editable.of(true),
        EditorState.readOnly.of(true),
      ]),
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("a docChanged transaction that ALSO revokes write access collapses (no branch-ordering leak — Codex #1)", () => {
    let s = start(FM, EditorSelection.cursor(6));
    s = s.update({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } }).state;
    expect(s.field(probe).kind).toBe("revealed");
    // Combined edit + revoke in ONE transaction: branch (1)'s carry would
    // otherwise keep it revealed; the post-branch writable normalization collapses.
    s = s.update({
      changes: { from: 6, insert: "z" },
      selection: { anchor: 7 },
      effects: writableComp.reconfigure([
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ]),
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
  it("the FIRST applyDocument-shaped reseed from empty seeds collapsed (block-on-open)", () => {
    let s = start("", EditorSelection.cursor(0));
    expect(s.field(probe).kind).toBe("absent");
    s = s.update({
      annotations: hostDocumentReseed.of(true),
      changes: { from: 0, insert: FM },
    }).state;
    expect(s.field(probe).kind).toBe("collapsed");
  });
});

describe("revealFrontmatterAt — single-dispatch command", () => {
  function mountView(doc: string, editable = true): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          writableComp.of([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
          markdown({ base: markdownLanguage }),
          probe,
        ],
      }),
      parent,
    });
  }
  it("reveals and lands the caret at the clamped anchor in ONE dispatch", () => {
    const view = mountView(FM);
    try {
      expect(revealFrontmatterAt(view, 6)).toBe(true);
      expect(view.state.field(probe).kind).toBe("revealed");
      expect(view.state.selection.main.head).toBe(6);
    } finally {
      view.destroy();
    }
  });
  it("clamps an anchor at span.to and still reveals (closed-interval intersect)", () => {
    const view = mountView(FM);
    try {
      expect(revealFrontmatterAt(view, TO)).toBe(true);
      expect(view.state.field(probe).kind).toBe("revealed");
      expect(view.state.selection.main.head).toBe(TO);
    } finally {
      view.destroy();
    }
  });
  it("no-ops when not editable", () => {
    const view = mountView(FM, false);
    try {
      expect(revealFrontmatterAt(view, 6)).toBe(false);
      expect(view.state.field(probe).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });
  it("no-ops when readOnly even if editable=true (readOnly authority)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: FM,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          EditorView.editable.of(true),
          EditorState.readOnly.of(true),
          markdown({ base: markdownLanguage }),
          probe,
        ],
      }),
      parent,
    });
    try {
      expect(revealFrontmatterAt(view, 6)).toBe(false);
      expect(view.state.field(probe).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });
});

describe("frontmatterRevealUp — ArrowUp into the block", () => {
  async function realView(doc: string): Promise<EditorView> {
    const { frontmatterBlockField } = await import("../../../src/webview/cm/frontmatter/index.js");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          EditorView.editable.of(true),
          EditorState.readOnly.of(false), // explicit — isWritable reads both facets
          markdown({ base: markdownLanguage }),
          frontmatterBlockField,
        ],
      }),
      parent,
    });
  }
  it("reveals + lands the caret on the closer line when stepping up from below", async () => {
    const { frontmatterBlockField } = await import("../../../src/webview/cm/frontmatter/index.js");
    const { frontmatterRevealUp } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-reveal-keymap.js"
    );
    const view = await realView(FM);
    try {
      view.dispatch({ selection: { anchor: TO + 1 } }); // line directly below the block
      expect(frontmatterRevealUp(view)).toBe(true);
      expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
      expect(view.state.selection.main.head).toBe(TO);
    } finally {
      view.destroy();
    }
  });
  it("passes through (false) when the caret is not directly below the block", async () => {
    const { frontmatterBlockField } = await import("../../../src/webview/cm/frontmatter/index.js");
    const { frontmatterRevealUp } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-reveal-keymap.js"
    );
    const view = await realView(FM);
    try {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(frontmatterRevealUp(view)).toBe(false);
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });
  it("passes through when there is no frontmatter", async () => {
    const { frontmatterRevealUp } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-reveal-keymap.js"
    );
    const view = await realView("# just a heading\n\nbody\n");
    try {
      view.dispatch({ selection: { anchor: 5 } });
      expect(frontmatterRevealUp(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });
});

describe("FrontmatterBlockWidget — mousedown reveals (toDOM wiring, no layout)", () => {
  function widgetView(editable = true): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc: FM,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          writableComp.of([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
          markdown({ base: markdownLanguage }),
          probe,
        ],
      }),
      parent,
    });
  }
  it("a LEFT mousedown on the widget DOM reveals the block", async () => {
    const { FrontmatterBlockWidget } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-widget.js"
    );
    const view = widgetView();
    try {
      const widget = new FrontmatterBlockWidget("title: x", FM.slice(0, TO));
      const dom = widget.toDOM(view); // attaches the mousedown listener
      dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(view.state.field(probe).kind).toBe("revealed");
    } finally {
      view.destroy();
    }
  });
  it("a RIGHT mousedown (button 2) does NOT reveal (context-menu safe — Codex #5)", async () => {
    const { FrontmatterBlockWidget } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-widget.js"
    );
    const view = widgetView();
    try {
      const widget = new FrontmatterBlockWidget("title: x", FM.slice(0, TO));
      const dom = widget.toDOM(view);
      dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
      expect(view.state.field(probe).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });

  it("advertises the caret-reveal hint (aria-description) when writable", async () => {
    const { FrontmatterBlockWidget } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-widget.js"
    );
    const view = widgetView(); // editable=true, readOnly=false
    try {
      const dom = new FrontmatterBlockWidget("title: x", FM.slice(0, TO)).toDOM(view);
      expect(dom.getAttribute("aria-description")).toMatch(/caret|edit/i);
    } finally {
      view.destroy();
    }
  });

  it("OMITS the aria-description hint on a read-only document (reveal is a no-op there, so no false affordance)", async () => {
    const { FrontmatterBlockWidget } = await import(
      "../../../src/webview/cm/frontmatter/frontmatter-widget.js"
    );
    const view = widgetView(false); // editable=false, readOnly=true
    try {
      const dom = new FrontmatterBlockWidget("title: x", FM.slice(0, TO)).toDOM(view);
      // The region still identifies itself (aria-label) but must NOT promise an
      // edit route that revealFrontmatterAt() silently refuses in read-only.
      expect(dom.getAttribute("aria-label")).toBe("Document metadata");
      expect(dom.getAttribute("aria-description")).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
