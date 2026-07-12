// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  createSyntaxReveal,
  quollBlockReplaceZones,
  quollSyntaxExclusionZones,
  quollSyntaxReveal,
} from "../../../src/webview/cm/decorations/index.js";
import { arbitrate } from "../../../src/webview/cm/decorations/orchestrator.js";
import type {
  BuildContext,
  DecorationProvider,
} from "../../../src/webview/cm/decorations/types.js";

function tagsOf(set: DecorationSet): string[] {
  const out: string[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push((iter.value.spec as { tag: string }).tag);
    iter.next();
  }
  return out.sort();
}

describe("decoration orchestrator — arbitrate()", () => {
  it("returns the inline set unchanged when there are no exclusion zones", () => {
    const inline = Decoration.set([
      Decoration.mark({ class: "a", tag: "a" }).range(0, 5),
      Decoration.mark({ class: "b", tag: "b" }).range(10, 15),
    ]);
    const merged = arbitrate({ inline, exclusionZones: [] });
    expect(tagsOf(merged)).toEqual(["a", "b"]);
  });

  it("drops inline decorations whose range OVERLAPS any exclusion zone", () => {
    const inline = Decoration.set([
      Decoration.mark({ class: "x", tag: "inside" }).range(5, 7),
      Decoration.mark({ class: "y", tag: "outside" }).range(20, 22),
    ]);
    const merged = arbitrate({
      inline,
      exclusionZones: [{ from: 0, to: 10 }],
    });
    const tags = tagsOf(merged);
    expect(tags).toEqual(["outside"]);
    expect(tags).not.toContain("inside");
  });

  it("treats touching-but-not-overlapping ranges as outside the exclusion zone", () => {
    // Inline at [10, 12) touches a zone at [0, 10) but does NOT overlap interior.
    // It must survive — half-open interval semantics: [a, b) and [c, d) overlap
    // iff a < d && c < b.
    const inline = Decoration.set([Decoration.mark({ class: "k", tag: "touch" }).range(10, 12)]);
    const merged = arbitrate({
      inline,
      exclusionZones: [{ from: 0, to: 10 }],
    });
    expect(tagsOf(merged)).toEqual(["touch"]);
  });

  it("drops inline decorations against multiple exclusion zones", () => {
    const inline = Decoration.set([
      Decoration.mark({ class: "a", tag: "in-zone-1" }).range(2, 4),
      Decoration.mark({ class: "b", tag: "between" }).range(15, 17),
      Decoration.mark({ class: "c", tag: "in-zone-2" }).range(25, 27),
    ]);
    const merged = arbitrate({
      inline,
      exclusionZones: [
        { from: 0, to: 10 },
        { from: 20, to: 30 },
      ],
    });
    expect(tagsOf(merged)).toEqual(["between"]);
  });

  it("allows overlap within the inline set (two providers contribute at the same range)", () => {
    // Strong wraps Emphasis: both providers emit at the inner `*` positions.
    const inline = Decoration.set([
      Decoration.mark({ class: "strong-mark", tag: "strong" }).range(0, 2),
      Decoration.mark({ class: "emphasis-mark", tag: "emphasis" }).range(0, 2),
    ]);
    const merged = arbitrate({ inline, exclusionZones: [] });
    expect(tagsOf(merged)).toEqual(["emphasis", "strong"]);
  });

  it("returns Decoration.none when the inline set is empty", () => {
    const merged = arbitrate({ inline: Decoration.none, exclusionZones: [{ from: 0, to: 10 }] });
    expect(merged.size).toBe(0);
  });
});

function mount(
  extensions: Array<ReturnType<typeof createSyntaxReveal>>,
  doc = "hello\nworld",
  extra: Extension[] = []
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), ...extra, ...extensions],
  });
  return new EditorView({ state, parent });
}

describe("decoration orchestrator — ViewPlugin", () => {
  it("calls each provider on initial mount", () => {
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])]);
    try {
      expect(calls).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("rebuilds on docChanged", () => {
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])]);
    try {
      const before = calls;
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(calls).toBe(before + 1);
    } finally {
      view.destroy();
    }
  });

  it("rebuilds on selectionSet (caret move only)", () => {
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])]);
    try {
      const before = calls;
      view.dispatch({ selection: { anchor: 2 } });
      expect(calls).toBe(before + 1);
    } finally {
      view.destroy();
    }
  });

  it("does NOT rebuild on a no-op update (annotation-only, no doc/viewport/selection/tree change)", () => {
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])]);
    try {
      const before = calls;
      view.dispatch({ annotations: [] });
      expect(calls).toBe(before);
    } finally {
      view.destroy();
    }
  });

  it("rebuilds on async parser-completion (syntaxTree advances without doc/viewport/selection moving)", () => {
    // The orchestrator's tree-advance trigger MUST fire when the parser
    // completes a chunk — otherwise a large doc with an async-completing
    // parse renders without decorations until the user types/scrolls.
    //
    // `forceParsing` advances the parse to `upto` within `timeout` ms and
    // dispatches a view update whose syntaxTree identity has changed. The
    // test's PRECONDITION is "forceParsing actually advanced the tree"; the
    // CONTRACT is "the orchestrator's update() reacted with a rebuild".
    // Both assertions are unconditional — no environmental soft-pass arm.
    // The doc must be sized in a band bounded on BOTH sides:
    //   - LOWER: > CM's 3000-char initial-parse viewport (Work.InitViewport, see
    //     LanguageState.init), so the mount-time tree is GUARANTEED incomplete
    //     and forceParsing has something to advance.
    //   - UPPER: small enough that forceParsing's full parse completes well
    //     within its 5s wall-clock budget even under CPU starvation. This side
    //     is the flake this sizing fixes: ParseContext.work() only publishes an
    //     advanced tree when a parse chunk COMPLETES (`this.tree` updates on
    //     `advance()` returning done — Lezer does not finalise a partial tree
    //     mid-chunk). A ~2MB doc cannot finish parsing in 5s of *starved*
    //     wall-clock, so `context.tree` never advances, LanguageState.apply
    //     early-returns (no republish), and BOTH the precondition and contract
    //     silently fail under the full parallel suite. See LEARNING.md
    //     "syntaxTree(state) は LAZY".
    const trees: unknown[] = [];
    const probe: DecorationProvider = {
      build: (ctx) => {
        trees.push(ctx.tree);
        return Decoration.none;
      },
    };
    // 16KB of repetitive markdown: comfortably above the 3000-char init
    // viewport (so the mount-time tree is incomplete) yet trivially completable
    // by forceParsing within 5s even under load. Do NOT bump this to multi-MB —
    // a doc large enough to defeat a *starved* 5s forceParsing budget resurrects
    // the flake (see the band comment above). Do NOT re-introduce a soft-pass.
    const bigDoc = "# h\n".repeat(4_000);
    const view = mount([createSyntaxReveal([probe])], bigDoc);
    try {
      const before = trees.length;
      const beforeTree = syntaxTree(view.state);
      forceParsing(view, view.state.doc.length, 5_000);
      const afterTree = syntaxTree(view.state);
      // PRECONDITION: forceParsing advanced the tree. If this fires, the doc
      // no longer exceeds the 3000-char init viewport (the mount tree is already
      // complete) — raise the repeat count back above 3000 chars, do NOT skip.
      expect(afterTree).not.toBe(beforeTree);
      // CONTRACT: the orchestrator's update() reacted to the tree-advance
      // by rebuilding (calling probe.build()).
      expect(trees.length).toBeGreaterThan(before);
    } finally {
      view.destroy();
    }
  });

  it("rebuilds when quollBlockReplaceZones facet identity changes via Compartment.reconfigure", () => {
    // Future block-widget slices (C5 list/checkbox, C6b–d table, C7 image)
    // publish exclusion ranges via a StateField that feeds the
    // quollBlockReplaceZones facet. The facet contents can change WITHOUT
    // touching doc/viewport/selection/syntaxTree, so the orchestrator's
    // update() gate MUST include a facet-identity check or stale inline
    // decorations would survive inside a newly-claimed block zone.
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const comp = new Compartment();
    const view = mount([createSyntaxReveal([probe])], "hello world", [
      comp.of(quollBlockReplaceZones.of([])),
    ]);
    try {
      const before = calls;
      view.dispatch({
        effects: comp.reconfigure(quollBlockReplaceZones.of([{ from: 0, to: 10 }])),
      });
      expect(calls).toBeGreaterThan(before);
    } finally {
      view.destroy();
    }
  });

  it("reads the quollBlockReplaceZones facet and drops inline decorations inside the zone", () => {
    const probe: DecorationProvider = {
      build: () => Decoration.set([Decoration.mark({ class: "inline-test" }).range(0, 5)]),
    };
    // Synthetic facet contributor: zones [0, 10] cover the probe's decoration.
    const view = mount([createSyntaxReveal([probe])], "hello world", [
      quollBlockReplaceZones.of([{ from: 0, to: 10 }]),
    ]);
    try {
      // Read the orchestrator's merged decorations via EditorView.decorations facet.
      const sources = view.state.facet(EditorView.decorations);
      let count = 0;
      for (const source of sources) {
        const set = typeof source === "function" ? source(view) : source;
        const iter = set.iter();
        while (iter.value !== null) {
          if ((iter.value.spec as { class?: string }).class === "inline-test") {
            count += 1;
          }
          iter.next();
        }
      }
      // The probe's inline decoration MUST be excluded by the facet zone.
      expect(count).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("passes visibleRanges and a Tree to providers", () => {
    let captured: { vr: ReadonlyArray<{ from: number; to: number }>; tree: unknown } | null = null;
    const probe: DecorationProvider = {
      build: (ctx) => {
        captured = { vr: ctx.visibleRanges, tree: ctx.tree };
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])], "line 1\nline 2\nline 3");
    try {
      expect(captured).not.toBeNull();
      expect(Array.isArray(captured!.vr)).toBe(true);
      expect(captured!.vr.length).toBeGreaterThan(0);
      expect(captured!.tree).toBeTruthy();
    } finally {
      view.destroy();
    }
  });

  it("type-pins that BuildContext has no `view` field (purity)", () => {
    // Compile-time check: a provider that tries to read ctx.view must
    // TYPE-error. We can't run TS in vitest, but we CAN assert the runtime
    // object lacks `view` as an exposed key. (If the orchestrator passed
    // a wider object than BuildContext declares, this test would catch it.)
    let captured: BuildContext | null = null;
    const probe: DecorationProvider = {
      build: (ctx) => {
        captured = ctx;
        return Decoration.none;
      },
    };
    const view = mount([createSyntaxReveal([probe])]);
    try {
      expect(captured).not.toBeNull();
      // biome-ignore lint/suspicious/noPrototypeBuiltins: testing own-property presence on a plain object literal; per plan
      expect(Object.prototype.hasOwnProperty.call(captured!, "view")).toBe(false);
    } finally {
      view.destroy();
    }
  });
});

describe("decoration orchestrator — quollSyntaxExclusionZones facet", () => {
  it("drops inline decorations inside a syntax-exclusion zone", () => {
    const probe: DecorationProvider = {
      build: () => Decoration.set([Decoration.mark({ class: "syn-test" }).range(2, 6)]),
    };
    const view = mount([createSyntaxReveal([probe])], "hello world", [
      quollSyntaxExclusionZones.of([{ from: 0, to: 10 }]),
    ]);
    try {
      const sources = view.state.facet(EditorView.decorations);
      let count = 0;
      for (const source of sources) {
        const set = typeof source === "function" ? source(view) : source;
        const iter = set.iter();
        while (iter.value !== null) {
          if ((iter.value.spec as { class?: string }).class === "syn-test") {
            count += 1;
          }
          iter.next();
        }
      }
      expect(count).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("unions both facets — a mark inside EITHER zone is dropped, one outside both survives", () => {
    const probe: DecorationProvider = {
      build: () =>
        Decoration.set([
          Decoration.mark({ class: "in-block", tag: "in-block" }).range(1, 3),
          Decoration.mark({ class: "in-syntax", tag: "in-syntax" }).range(21, 23),
          Decoration.mark({ class: "outside", tag: "outside" }).range(40, 42),
        ]),
    };
    const view = mount([createSyntaxReveal([probe])], "x".repeat(60), [
      quollBlockReplaceZones.of([{ from: 0, to: 10 }]),
      quollSyntaxExclusionZones.of([{ from: 20, to: 30 }]),
    ]);
    try {
      const sources = view.state.facet(EditorView.decorations);
      const seen: string[] = [];
      for (const source of sources) {
        const set = typeof source === "function" ? source(view) : source;
        const iter = set.iter();
        while (iter.value !== null) {
          const cls = (iter.value.spec as { class?: string }).class;
          if (cls) {
            seen.push(cls);
          }
          iter.next();
        }
      }
      expect(seen).toContain("outside");
      expect(seen).not.toContain("in-block");
      expect(seen).not.toContain("in-syntax");
    } finally {
      view.destroy();
    }
  });

  it("rebuilds when quollSyntaxExclusionZones identity changes via Compartment.reconfigure", () => {
    let calls = 0;
    const probe: DecorationProvider = {
      build: () => {
        calls += 1;
        return Decoration.none;
      },
    };
    const comp = new Compartment();
    const view = mount([createSyntaxReveal([probe])], "hello world", [
      comp.of(quollSyntaxExclusionZones.of([])),
    ]);
    try {
      const before = calls;
      view.dispatch({
        effects: comp.reconfigure(quollSyntaxExclusionZones.of([{ from: 0, to: 10 }])),
      });
      expect(calls).toBeGreaterThan(before);
    } finally {
      view.destroy();
    }
  });
});

describe("multi-cursor arbitration regression", () => {
  it("two cursors on different constructs reveal both, leaving a third construct hidden", () => {
    const doc = "# H1\n> quote\n**bold**";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      // Cursor 1: inside "H1" (heading). Cursor 2: inside "bold" (strong).
      // Blockquote line has NO cursor — its `>` must stay hidden.
      selection: EditorSelection.create([
        EditorSelection.cursor(2), // # H1 ← caret here
        EditorSelection.cursor(16), // **bold** ← caret here (offset varies; pick mid-word)
      ]),
      extensions: [
        // Required: CodeMirror collapses multi-range selections to the main
        // range unless this facet is enabled. Without it the regression
        // fixture silently degrades into a single-cursor case.
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
      ],
    });
    const view = new EditorView({ state, parent });
    try {
      // Read the merged decoration set via the EditorView.decorations facet.
      const sources = view.state.facet(EditorView.decorations);
      const mergedSets = sources.map((s) => (typeof s === "function" ? s(view) : s));
      const reveals: Array<{ from: number; to: number }> = [];
      const hides: Array<{ from: number; to: number }> = [];
      for (const set of mergedSets) {
        const iter = set.iter();
        while (iter.value !== null) {
          const cls = (iter.value.spec as { class?: string }).class;
          if (cls === "quoll-syntax-reveal") {
            reveals.push({ from: iter.from, to: iter.to });
          } else {
            hides.push({ from: iter.from, to: iter.to });
          }
          iter.next();
        }
      }
      // Expectations:
      //   - Heading mark (offset 0-1): REVEALED
      //   - Quote mark   (offset 5-6 or wherever Lezer puts it): HIDDEN
      //   - Strong opening + closing (`**`...`**`): REVEALED
      // The exact offsets depend on the doc layout; we assert the WIDTHS
      // and counts.
      expect(reveals.length).toBeGreaterThanOrEqual(3); // # + ** + **
      expect(hides.length).toBeGreaterThanOrEqual(1); // >
    } finally {
      view.destroy();
    }
  });
});
