// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  type SelectionRange,
  Text,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  quollBlockReplaceZones,
  quollSyntaxExclusionZones,
} from "../../src/webview/cm/decorations/orchestrator.js";
import { FrontmatterBlockWidget } from "../../src/webview/cm/frontmatter/frontmatter-widget.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/index.js";
import { hostDocumentReseed } from "../../src/webview/cm/frontmatter/reveal-state.js";

// Extract the frontmatter block-replace ranges from the field-provided
// decorations — pure state, no view layout, so it is non-flaky under happy-dom
// (which does not measure block widgets). Proves the fence span is REPLACED by a
// block widget (i.e. not rendered as source / an HR).
function frontmatterDecoRanges(view: EditorView): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = set.iter();
    while (iter.value !== null) {
      const widget = (iter.value.spec as { widget?: unknown }).widget;
      if (widget instanceof FrontmatterBlockWidget) {
        out.push({ from: iter.from, to: iter.to });
      }
      iter.next();
    }
  }
  return out;
}

function mount(doc: string, selection?: EditorSelection | SelectionRange): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const len = EditorState.create({ doc }).doc.length;
  const state = EditorState.create({
    doc,
    selection: selection ?? EditorSelection.cursor(len),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      frontmatterBlockField,
    ],
  });
  return new EditorView({ state, parent });
}

const FM = "---\ntitle: x\n---\n\n# Body\n";
const SPAN_TO = "---\ntitle: x\n---".length; // 16

describe("frontmatterBlockField — detection + read-only block", () => {
  it("detects the span and provides one block-replace over [0, to]", () => {
    const view = mount(FM);
    try {
      const v = view.state.field(frontmatterBlockField);
      expect(v.kind).toBe("collapsed");
      if (v.kind !== "collapsed") {
        throw new Error("expected collapsed");
      }
      expect(v.span.to).toBe(SPAN_TO);
      expect(v.span.body).toBe("title: x");
      expect(frontmatterDecoRanges(view)).toEqual([{ from: 0, to: SPAN_TO }]);
    } finally {
      view.destroy();
    }
  });

  it("stays shown regardless of caret position (read-only; caret at 0 does not reveal)", () => {
    const view = mount(FM, EditorSelection.cursor(0));
    try {
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
      expect(frontmatterDecoRanges(view)).toEqual([{ from: 0, to: SPAN_TO }]);
    } finally {
      view.destroy();
    }
  });

  it("contributes the span to quollSyntaxExclusionZones when COLLAPSED (and not to blockReplaceZones)", () => {
    const view = mount(FM);
    try {
      expect(view.state.facet(quollSyntaxExclusionZones)).toEqual([{ from: 0, to: SPAN_TO }]);
      expect(view.state.facet(quollBlockReplaceZones)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });
  it("still contributes the span to quollSyntaxExclusionZones when REVEALED", async () => {
    const { revealFrontmatterEffect } = await import(
      "../../src/webview/cm/frontmatter/reveal-state.js"
    );
    const view = mount(FM, EditorSelection.cursor(SPAN_TO + 1));
    try {
      view.dispatch({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } });
      expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
      expect(view.state.facet(quollSyntaxExclusionZones)).toEqual([{ from: 0, to: SPAN_TO }]);
    } finally {
      view.destroy();
    }
  });
});

describe("frontmatterBlockField — eligibility (NOT an <hr>)", () => {
  it.each([
    ["leading `---` with no closer", "---\n\n# heading\n"],
    ["`---` not at doc start", "# heading\n\n---\n\nmore\n"],
    ["first line is not a fence", "# heading\ntitle: x\n"],
  ])("emits no block for %s", (_label, doc) => {
    const view = mount(doc);
    try {
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
      expect(frontmatterDecoRanges(view)).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});

describe("frontmatterBlockField — read-only (mutation guard, not just atomic)", () => {
  it("drops a user-origin delete of the span (atomic Backspace at the boundary)", () => {
    // atomicRanges would expand a Backspace at `span.to` to delete [0, to];
    // the transactionFilter must protect that range so the block survives. A
    // direct dispatch of the same change is the strongest form of this assertion.
    const view = mount(FM, EditorSelection.cursor(SPAN_TO));
    try {
      view.dispatch({ changes: { from: 0, to: SPAN_TO, insert: "" } });
      expect(view.state.sliceDoc()).toBe(FM); // unchanged — delete was filtered
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });

  it("drops a zero-width insertion at the OPEN boundaries (offset 0 and span.to)", () => {
    // A `changeFilter` range-array `[0, span.to]` has OPEN boundaries: a
    // zero-width insert AT 0 or AT span.to is admitted, and atomicRanges'
    // caret-skip only fires on the strict interior — so a keystroke there would
    // prepend/append to the `---` fence. The transactionFilter must veto both.
    for (const at of [0, SPAN_TO]) {
      const view = mount(FM, EditorSelection.cursor(at));
      try {
        view.dispatch({ changes: { from: at, insert: "X" } });
        expect(view.state.sliceDoc()).toBe(FM); // unchanged — boundary insert vetoed
        expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
      } finally {
        view.destroy();
      }
    }
  });

  it("keeps the body editable (a change past the span still applies)", () => {
    const view = mount(FM);
    try {
      const end = view.state.doc.length; // well past the frontmatter span
      view.dispatch({ changes: { from: end, insert: "x" } });
      expect(view.state.sliceDoc()).toBe(`${FM}x`);
    } finally {
      view.destroy();
    }
  });

  it("select-all + type replaces the whole document (frontmatter overwritten, no silent no-op)", () => {
    // Cmd+A puts a non-empty selection over [0, doc.length] — spanning the
    // collapsed frontmatter AND the body. Typing then replaces that range. The
    // read-only veto must NOT drop this transaction (a bulk replace cleanly
    // overwrites the block, it never leaves a half-corrupt fence), otherwise the
    // keystroke is a silent no-op.
    const view = mount(FM, EditorSelection.range(0, FM.length));
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "x" },
        selection: EditorSelection.cursor(1),
      });
      expect(view.state.sliceDoc()).toBe("x"); // body replaced, not a no-op
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
    } finally {
      view.destroy();
    }
  });

  it("select-all + Delete clears the document (frontmatter included)", () => {
    const view = mount(FM, EditorSelection.range(0, FM.length));
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
      expect(view.state.sliceDoc()).toBe(""); // cleared, not a no-op
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
    } finally {
      view.destroy();
    }
  });

  it("a selection covering the block AND part of the body (not to doc end) still replaces", () => {
    // Selecting from doc start through the middle of the body — covers the whole
    // block and extends past span.to but stops short of the document end. This is
    // still a bulk replace; the allow-condition must NOT require reaching doc end.
    const view = mount(FM, EditorSelection.range(0, SPAN_TO + 3));
    try {
      view.dispatch({
        changes: { from: 0, to: SPAN_TO + 3, insert: "q" },
        selection: EditorSelection.cursor(1),
      });
      expect(view.state.sliceDoc()).toBe(`q${FM.slice(SPAN_TO + 3)}`); // replaced, not a no-op
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
    } finally {
      view.destroy();
    }
  });

  it("a block-ONLY selection [0, span.to] in a doc with body is still vetoed (not a bulk replace)", () => {
    // A non-empty selection of EXACTLY the collapsed block, in a document that
    // still has body past span.to, is reachable via the keyboard (pos 0 →
    // Shift+Right skips the atomic block to span.to). It must NOT be treated as a
    // select-all — allowing it would silently delete the metadata card while the
    // body survives.
    const view = mount(FM, EditorSelection.range(0, SPAN_TO));
    try {
      view.dispatch({ changes: { from: 0, to: SPAN_TO, insert: "" } });
      expect(view.state.sliceDoc()).toBe(FM); // unchanged — block-only selection is not bulk
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });

  it("select-all + type on a frontmatter-only doc still replaces (no body past the span)", () => {
    // A doc that is ONLY frontmatter: span.to === doc.length, so the covering
    // change ends AT span.to (not past it). The non-empty covering selection is
    // what authorises the replace — geometry alone (change extends past span.to)
    // would miss this.
    const only = "---\ntitle: x\n---";
    const view = mount(only, EditorSelection.range(0, only.length));
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "z" },
        selection: EditorSelection.cursor(1),
      });
      expect(view.state.sliceDoc()).toBe("z");
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
    } finally {
      view.destroy();
    }
  });

  it("a partial selection covering only the fence interior is still vetoed (corruption guard)", () => {
    // Selecting [0, 6] (into the fence, NOT past span.to) and typing would corrupt
    // the block — this must stay blocked even though the selection is non-empty.
    const view = mount(FM, EditorSelection.range(0, 6));
    try {
      view.dispatch({ changes: { from: 0, to: 6, insert: "z" } });
      expect(view.state.sliceDoc()).toBe(FM); // unchanged — not a whole-span replace
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });

  it("still lets a host reseed replace the whole document", () => {
    const view = mount(FM);
    try {
      const next = "---\ntitle: y\n---\n\n# New\n";
      view.dispatch({
        annotations: hostDocumentReseed.of(true),
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
      expect(view.state.sliceDoc()).toBe(next);
      const v = view.state.field(frontmatterBlockField);
      expect(v.kind).toBe("collapsed");
      if (v.kind === "collapsed") {
        expect(v.span.body).toBe("title: y");
      }
    } finally {
      view.destroy();
    }
  });

  it("an addToHistory=false mutation WITHOUT hostDocumentReseed is still blocked (annotation migration)", () => {
    const view = mount(FM, EditorSelection.cursor(SPAN_TO));
    try {
      view.dispatch({
        annotations: Transaction.addToHistory.of(false), // NOT a reseed marker
        changes: { from: 0, to: SPAN_TO, insert: "" },
      });
      expect(view.state.sliceDoc()).toBe(FM); // unchanged — only hostDocumentReseed bypasses
      expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    } finally {
      view.destroy();
    }
  });
});

describe("frontmatterBlockField — round-trip (byte-identical)", () => {
  it("never mutates an LF document", () => {
    const view = mount(FM);
    try {
      expect(view.state.sliceDoc()).toBe(FM);
    } finally {
      view.destroy();
    }
  });

  it("never mutates a CRLF document (production-like seed)", () => {
    const raw = "---\r\ntitle: x\r\n---\r\nbody\r\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: Text.of(raw.split(/\r\n?|\n/)),
      selection: EditorSelection.cursor(0),
      extensions: [
        EditorState.lineSeparator.of("\r\n"),
        markdown({ base: markdownLanguage }),
        frontmatterBlockField,
      ],
    });
    const view = new EditorView({ state, parent });
    try {
      const v = view.state.field(frontmatterBlockField);
      if (v.kind === "collapsed") {
        expect(v.span.body).toBe("title: x");
      }
      expect(view.state.sliceDoc()).toBe(raw); // CRLF preserved exactly
    } finally {
      view.destroy();
    }
  });

  it("re-detects after a host reseed changes the fence (docChanged recompute)", () => {
    const view = mount(FM);
    try {
      // The read-only changeFilter blocks user edits INSIDE the span, so a fence
      // can only change via a host reseed. Reseed a doc whose closer is broken
      // (`--`, not a fence) → no valid frontmatter.
      view.dispatch({
        annotations: hostDocumentReseed.of(true),
        changes: { from: 0, to: view.state.doc.length, insert: "---\ntitle: x\n--\n\n# Body\n" },
      });
      expect(view.state.field(frontmatterBlockField).kind).toBe("absent");
      expect(frontmatterDecoRanges(view)).toEqual([]);
    } finally {
      view.destroy();
    }
  });

  it("revealing drops the block-replace decoration (raw source shown)", async () => {
    const { revealFrontmatterEffect } = await import(
      "../../src/webview/cm/frontmatter/reveal-state.js"
    );
    const view = mount(FM, EditorSelection.cursor(SPAN_TO + 1));
    try {
      expect(frontmatterDecoRanges(view)).toEqual([{ from: 0, to: SPAN_TO }]);
      view.dispatch({ effects: revealFrontmatterEffect.of(null), selection: { anchor: 6 } });
      expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
      expect(frontmatterDecoRanges(view)).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});
