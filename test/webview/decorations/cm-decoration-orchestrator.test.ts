// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

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

// --- provider build() throw containment ------------------------------------

/** Every decoration class currently published through the EditorView.decorations
 *  facet — i.e. what the user would actually see rendered. */
function decorationClasses(view: EditorView): string[] {
  const out: string[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = set.iter();
    while (iter.value !== null) {
      const cls = (iter.value.spec as { class?: string }).class;
      if (cls) {
        out.push(cls);
      }
      iter.next();
    }
  }
  return out;
}

/** A provider contributing one mark with `cls`. FRESH object per call — see the
 *  dedup note in the describe below. */
function markProvider(cls: string): DecorationProvider {
  return { build: () => Decoration.set([Decoration.mark({ class: cls }).range(0, 5)]) };
}

describe("decoration orchestrator — provider build() throw containment", () => {
  // NOTE: the orchestrator's log-dedup state is module-level and vitest keeps
  // module state across tests in a file, so EVERY test below uses its OWN fresh
  // provider object (`markProvider` returns a new one per call, and the
  // throwing providers are inline literals). Sharing a fixture would make the
  // log-count assertions order-dependent.

  // console.error is spied for EVERY test here and restored ONLY in afterEach:
  // `mount()` runs OUTSIDE each test's try/finally, so on exactly the
  // regression class these tests exist to catch — a provider poisoning the
  // accumulator until EditorView's constructor throws — an inline restore would
  // never run, and the leaked spy would corrupt the NEXT test's log count,
  // turning one clean localised failure into a confusing cascade.
  let errorSpy: MockInstance<typeof console.error>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Only OUR log lines. CodeMirror's own logException falls back through
   *  exceptionSink → window.onerror → console.error, so whether it reaches
   *  console.error at all is environment-dependent under happy-dom — asserting
   *  on the TOTAL console.error count would be flaky. */
  function quollErrorCalls(): unknown[][] {
    return errorSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[quoll]")
    );
  }

  function quollErrorCount(): number {
    return quollErrorCalls().length;
  }

  it("keeps every other provider's decorations when one provider's build() throws", () => {
    // A throw from ANY provider propagates out of the single shared
    // orchestrator ViewPlugin, and CodeMirror's PluginInstance.update responds
    // by deactivate()-ing it PERMANENTLY (spec/value nulled, no reconstruction
    // path) — taking down every inline decoration in the editor until the
    // window is reloaded. The guard must contain the throw to its own provider.
    let throwingCalls = 0;
    const throwing: DecorationProvider = {
      build: () => {
        throwingCalls += 1;
        throw new Error("provider exploded");
      },
    };
    const good = markProvider("survivor");
    const view = mount([createSyntaxReveal([throwing, good])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      const before = throwingCalls;
      view.dispatch({ changes: { from: 0, insert: "x" } });
      // Still rebuilding after the throw ⇒ the plugin was NOT deactivated. The
      // guard skips the failing provider's OUTPUT; it does not disable it.
      expect(throwingCalls).toBe(before + 1);
      expect(decorationClasses(view)).toContain("survivor");
    } finally {
      view.destroy();
    }
  });

  it("keeps decorations accumulated BEFORE the throwing provider (order-independence)", () => {
    const good = markProvider("earlier");
    const throwing: DecorationProvider = {
      build: () => {
        throw new Error("provider exploded");
      },
    };
    const view = mount([createSyntaxReveal([good, throwing])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("earlier");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("earlier");
    } finally {
      view.destroy();
    }
  });

  it("contains a provider that RETURNS a non-RangeSet instead of throwing", () => {
    // RangeSet.join([acc, built]) starts from `result = built` and only enters
    // its merge loop while `acc != RangeSet.empty`. With an EMPTY accumulator
    // (first provider, or every earlier provider returned none) a null return
    // is passed straight through UNTHROWN — poisoning `inline`, which then
    // either makes the NEXT provider's join throw (blaming an innocent
    // provider) or reaches `this.decorations = null` and throws when CodeMirror
    // reads the facet, OUTSIDE the guard. So the guard must validate the
    // returned value, not merely catch throws.
    const bad: DecorationProvider = {
      build: () => null as unknown as DecorationSet,
    };
    const good = markProvider("survivor");
    // `bad` FIRST, so the accumulator is Decoration.none — the passthrough case.
    const view = mount([createSyntaxReveal([bad, good])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("survivor");
    } finally {
      view.destroy();
    }
  });

  it("logs a repeated IDENTICAL failure only once", () => {
    // computeMerged runs on every keystroke and caret move — an un-deduped log
    // would flood the console for as long as the document keeps the construct.
    const throwing: DecorationProvider = {
      build: () => {
        throw new Error("same failure every time");
      },
    };
    const view = mount([createSyntaxReveal([throwing])], "hello world");
    try {
      view.dispatch({ changes: { from: 0, insert: "x" } });
      view.dispatch({ changes: { from: 0, insert: "y" } });
      expect(quollErrorCount()).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("logs again when the SAME provider fails for a DIFFERENT reason", () => {
    // Deduping on provider identity alone would silence a genuinely new
    // regression for the rest of the session once the provider had failed once
    // for any earlier, unrelated cause. This pins the dedup KEY.
    let builds = 0;
    const throwing: DecorationProvider = {
      build: () => {
        builds += 1;
        throw new Error(builds <= 2 ? "alpha failure" : "beta failure");
      },
    };
    const view = mount([createSyntaxReveal([throwing])], "hello world");
    try {
      view.dispatch({ changes: { from: 0, insert: "x" } }); // build 2 — alpha again
      view.dispatch({ changes: { from: 0, insert: "y" } }); // build 3 — beta
      expect(quollErrorCount()).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("caps how many distinct failures one provider may log", () => {
    // Messages are provider-authored and not a finite set, so the per-provider
    // signature set is bounded. Six failures differing along a NON-digit axis
    // (normalisation cannot merge them) must yield exactly the cap, 5.
    let builds = 0;
    const throwing: DecorationProvider = {
      build: () => {
        builds += 1;
        // No clamp: `expect(builds).toBe(6)` below runs BEFORE the log-count
        // assertion, so an extra build fails the test either way.
        throw new Error(`fail ${"ABCDEF"[builds - 1]}`);
      },
    };
    const view = mount([createSyntaxReveal([throwing])], "hello world");
    try {
      for (const ch of ["a", "b", "c", "d", "e"]) {
        view.dispatch({ changes: { from: 0, insert: ch } });
      }
      expect(builds).toBe(6);
      expect(quollErrorCount()).toBe(5);
    } finally {
      view.destroy();
    }
  });

  it("contains a hostile error value that makes the LOGGING path itself throw", () => {
    // The reporting path runs inside the catch, so if IT throws, the exception
    // escapes computeMerged and lands on the permanent deactivate() — the guard
    // becoming the very crash it exists to prevent. `Object.create(null)` has no
    // prototype and therefore no primitive conversion, so `String(err)` throws
    // "Cannot convert object to primitive value" (and `err instanceof Error` is
    // false, so that is the branch taken).
    const hostile: DecorationProvider = {
      build: () => {
        throw Object.create(null);
      },
    };
    const good = markProvider("survivor");
    const view = mount([createSyntaxReveal([hostile, good])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("survivor");
      // Contained AND still diagnosed: failureSignature degrades to a
      // placeholder rather than letting the outer catch swallow the report,
      // and the placeholder dedupes like any other signature (one line, not
      // one per build).
      expect(quollErrorCount()).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("contains a NON-OBJECT provider entry (the dedup WeakMap key would throw)", () => {
    // A plausible future edit to syntaxRevealProviders — `flag && codeRefReveal`
    // — leaves `false` in the array. `p.build(ctx)` throws first, which the
    // guard catches; the interesting part is the reporting path, where
    // WeakMap.set(false, …) throws "Invalid value used as weak map key". Only
    // the try/catch AROUND logProviderFailure covers this — normalising the
    // error message cannot, since the throw is not about the error value.
    const good = markProvider("survivor");
    const view = mount(
      [createSyntaxReveal([false as unknown as DecorationProvider, good])],
      "hello world"
    );
    try {
      expect(decorationClasses(view)).toContain("survivor");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("survivor");
    } finally {
      view.destroy();
    }
  });

  it("collapses position-varying instances of ONE bug into a single log", () => {
    // The cap is only safe because signatures are digit-normalised. A
    // RangeError from doc.lineAt(pos) embeds the position, so one caret-
    // following bug would otherwise mint a fresh signature per keystroke and
    // eat the whole cap within seconds — silencing the provider before any
    // genuinely unrelated failure could ever log.
    let builds = 0;
    const throwing: DecorationProvider = {
      build: () => {
        builds += 1;
        throw new RangeError(`Position ${builds * 37} out of range`);
      },
    };
    const view = mount([createSyntaxReveal([throwing])], "hello world");
    try {
      view.dispatch({ changes: { from: 0, insert: "x" } });
      view.dispatch({ changes: { from: 0, insert: "y" } });
      expect(builds).toBeGreaterThanOrEqual(3);
      expect(quollErrorCount()).toBe(1);
    } finally {
      view.destroy();
    }
  });

  class BlockStub extends WidgetType {
    toDOM(): HTMLElement {
      return document.createElement("div");
    }
    eq(): boolean {
      return true;
    }
  }

  /** A block widget at `pos` — the shape CodeMirror refuses from a plugin. */
  function blockWidget(pos: number): Range<Decoration> {
    return Decoration.widget({ widget: new BlockStub(), block: true }).range(pos);
  }

  it("contains a provider emitting a BLOCK decoration (CodeMirror forbids it from a plugin)", () => {
    // A well-formed RangeSet passes the instanceof check, so only a legality
    // check catches this. CodeMirror rejects it later, inside TileUpdate.emit's
    // own RangeSet.spans walk, reached from DocView.update → updateInner — NOT
    // inside PluginInstance.update's try, so it does not even get the permanent
    // deactivate(): it escapes view.dispatch() into our own caller and aborts
    // the update mid-flight.
    const bad: DecorationProvider = {
      build: () => Decoration.set([blockWidget(0)]),
    };
    const good = markProvider("survivor");
    const view = mount([createSyntaxReveal([bad, good])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      // The dispatch itself must COMPLETE — without the guard it throws out of
      // here, so this line is where the regression lands.
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(view.state.doc.toString()).toBe("xhello world");
      expect(decorationClasses(view)).toContain("survivor");
      expect(quollErrorCount()).toBe(1);
      // …and that the ONE log is this failure, not the detector falling over.
      // `logProviderFailure` logs a GENERIC first argument and passes the error
      // object third, so the count alone cannot tell "contained because the set
      // was illegal" from "contained because the detector itself threw". The
      // range and the "ship it as a StateField" instruction are the whole
      // diagnostic value of the thrown message, and nothing else pins them.
      const logged = quollErrorCalls()[0][2] as Error;
      expect(logged.message).toContain("a block decoration at 0..0");
      expect(logged.message).toContain("quollBlockReplaceZones");
    } finally {
      view.destroy();
    }
  });

  it("contains a provider whose replace spans a line break", () => {
    // The second thing CodeMirror refuses from a plugin, on the same escape
    // path. "hello\nworld" — [2, 8) crosses the newline at 5.
    const bad: DecorationProvider = {
      build: () => Decoration.set([Decoration.replace({}).range(2, 8)]),
    };
    const good = markProvider("survivor");
    const view = mount([createSyntaxReveal([bad, good])], "hello\nworld");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("survivor");
      expect(quollErrorCount()).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("contains an illegal decoration that spilled into a SECOND RangeSet layer", () => {
    // The realistic bug shape: the block widget overlaps a mark the same
    // provider emitted, so RangeSetBuilder spills it into a nextLayer. A guard
    // that consulted the set's top-level maxPoint would report this legal and
    // let the throw escape — the whole set reads maxPoint -1. CodeMirror still
    // throws for it, so this test is the one that pins layer handling end to
    // end.
    const bad: DecorationProvider = {
      build: () =>
        Decoration.set(
          [Decoration.mark({ class: "overlapped" }).range(0, 10), blockWidget(5)],
          true
        ),
    };
    const good = markProvider("survivor");
    const view = mount([createSyntaxReveal([bad, good])], "hello world");
    try {
      expect(decorationClasses(view)).toContain("survivor");
      // The whole provider is skipped, not just the offending range — a
      // half-applied provider output is exactly what the surrounding guard
      // exists to avoid.
      expect(decorationClasses(view)).not.toContain("overlapped");
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(decorationClasses(view)).toContain("survivor");
      expect(quollErrorCount()).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("CodeMirror really tolerates every shape the detector calls legal", () => {
    // Anchors findPluginIllegalDecoration to @codemirror/view rather than to
    // itself: every shape below is one the detector returns null for, emitted
    // from a BARE ViewPlugin (no orchestrator guard in the way) so CodeMirror's
    // own TileUpdate.emit check is the thing under test.
    //
    // Both paths are exercised, because they are not the same walk: at
    // construction emit() covers the whole document, while on a transaction it
    // runs once per CHANGED REGION — and the region walk is the one the guard's
    // clipping reasoning is about. So each fixture is mounted AND dispatched
    // through.
    //
    // The plugin recomputes from the current view on every update, and each
    // fixture is expressed relative to the live document length. A static set
    // would drift as the document grows and silently stop meaning what its name
    // says — a "past the end" fixture would wander into range and start
    // testing something else.
    const dynamic = (make: (doc: Text) => DecorationSet) =>
      ViewPlugin.fromClass(
        class {
          decorations: DecorationSet;
          constructor(view: EditorView) {
            this.decorations = make(view.state.doc);
          }
          update(u: ViewUpdate): void {
            this.decorations = make(u.state.doc);
          }
        },
        { decorations: (v) => v.decorations }
      );
    const doc = "hello\nworld\nagain";
    const fixtures: Array<(d: Text) => DecorationSet> = [
      // Wholly past the end, and straddling the end from inside the last line.
      (d) => Decoration.set([Decoration.replace({}).range(d.length, d.length + 8)]),
      (d) => Decoration.set([Decoration.replace({}).range(d.length - 3, d.length + 8)]),
      // The two shapes nothing but WALK GEOMETRY keeps legal, and so the two
      // most fragile verdicts in the module: a block decoration past the end is
      // legal only because RangeSet.spans never visits it, and a range wholly
      // before the document only because iter() starts at 0. Neither is a rule
      // we implement — both are upstream behaviour we depend on — so an upgrade
      // that started judging either would reopen the dispatch escape with no
      // other test going red.
      (d) => Decoration.set([blockWidget(d.length + 8)]),
      () => Decoration.set([Decoration.replace({}).range(-5, -3)]),
    ];
    for (const make of fixtures) {
      const view = mount([], doc, [dynamic(make)]);
      try {
        // The transaction must COMPLETE: an upstream change that started
        // judging these shapes would throw out of here, which is precisely the
        // escape the guard exists to prevent.
        view.dispatch({ changes: { from: 0, insert: "x" } });
        expect(view.state.doc.toString()).toBe(`x${doc}`);
      } finally {
        view.destroy();
      }
    }
    // The control proves the harness can still go red — without it, a CM
    // upgrade that stopped emitting the check at all would leave every
    // assertion above trivially green.
    expect(() => mount([], doc, [dynamic(() => Decoration.set([blockWidget(0)]))])).toThrow(
      /may not be specified via plugins/
    );
  });
});
