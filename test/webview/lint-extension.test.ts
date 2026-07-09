// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LintDiagnosticWire } from "../../src/shared/protocol.js";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";
import {
  buildLintDecorations,
  diagnosticsAt,
  lintField,
  quollLint,
  setLintDiagnostics,
  toWireDiagnostics,
} from "../../src/webview/cm/lint/extension.js";
import type { LintDiagnostic } from "../../src/webview/cm/lint/types.js";

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), quollLint()],
  });
}

// Collect the lint underline marks the view currently contributes (via the mapped
// lintDecorationsField → EditorView.decorations facet), as {from,to,cls} tuples.
function lintMarkRanges(view: EditorView): { from: number; to: number; cls?: string }[] {
  const out: { from: number; to: number; cls?: string }[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = set.iter();
    while (iter.value !== null) {
      const cls = (iter.value.spec as { class?: string }).class;
      if (cls?.startsWith("quoll-lint-mark-")) {
        out.push({ from: iter.from, to: iter.to, cls });
      }
      iter.next();
    }
  }
  return out;
}

describe("quollLint extension (state-level)", () => {
  it("computes initial diagnostics at field creation", () => {
    const diags = stateFor("# Title\n\n### Skip\n").field(lintField);
    expect(diags.some((d) => d.code === "heading-increment")).toBe(true);
  });

  it("never mutates the document (display-only, byte-identical)", () => {
    const doc = "# Title \n\n### Skip\n"; // trailing space + heading skip -> both rules
    const state = stateFor(doc);
    expect(state.sliceDoc()).toBe(doc);
    expect(state.field(lintField).length).toBeGreaterThanOrEqual(2);
  });

  it("applies the setLintDiagnostics effect to the field", () => {
    const state = stateFor("x");
    const next = state.update({
      effects: setLintDiagnostics.of([
        { from: 0, to: 1, severity: "warning", code: "no-trailing-spaces", message: "m" },
      ]),
    }).state;
    expect(next.field(lintField)).toEqual([
      { from: 0, to: 1, severity: "warning", code: "no-trailing-spaces", message: "m" },
    ]);
  });

  it("buildLintDecorations maps to severity-classed marks and sorts defensively", () => {
    // Deliberately UNSORTED + one zero-length entry that must be dropped.
    const diags: LintDiagnostic[] = [
      { from: 5, to: 9, severity: "info", code: "no-trailing-spaces", message: "n" },
      { from: 7, to: 7, severity: "warning", code: "no-trailing-spaces", message: "zero" },
      { from: 0, to: 3, severity: "warning", code: "no-trailing-spaces", message: "m" },
    ];
    const set = buildLintDecorations(diags);
    const out: { from: number; to: number; cls?: string }[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      out.push({
        from: iter.from,
        to: iter.to,
        cls: (iter.value.spec as { class?: string }).class,
      });
      iter.next();
    }
    expect(out).toEqual([
      { from: 0, to: 3, cls: "quoll-lint-mark-warning" },
      { from: 5, to: 9, cls: "quoll-lint-mark-info" },
    ]);
  });

  it("buildLintDecorations emits NO in-editor decoration for a wholeLine info diagnostic", () => {
    // A blank-line (no-multiple-blanks) info finding must not paint a full-line
    // block: a filled `Decoration.line` with an inset left-bar is indistinguishable
    // from a blockquote's left rule and would read as a phantom blockquote. The
    // finding surfaces via the Problems mirror / opt-in gutter dot / hover tooltip
    // instead. REVERT-CHECK: restoring the old `LINE_BY_SEVERITY[...].range(d.from)`
    // emission re-introduces a `.quoll-lint-line-info` line decoration and fails this.
    const diags: LintDiagnostic[] = [
      {
        from: 4,
        to: 4,
        severity: "info",
        code: "no-multiple-blanks",
        message: "blank",
        wholeLine: true,
      },
    ];
    const set = buildLintDecorations(diags);
    expect(set.iter().value).toBeNull(); // nothing painted in the editor
  });

  it("buildLintDecorations suppresses a wholeLine diagnostic but keeps a co-occurring mark", () => {
    const diags: LintDiagnostic[] = [
      { from: 10, to: 14, severity: "warning", code: "no-trailing-spaces", message: "mark" },
      {
        from: 4,
        to: 4,
        severity: "info",
        code: "no-trailing-spaces",
        message: "blank",
        wholeLine: true,
      },
    ];
    const set = buildLintDecorations(diags);
    const out: { from: number; to: number; cls?: string }[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      out.push({
        from: iter.from,
        to: iter.to,
        cls: (iter.value.spec as { class?: string }).class,
      });
      iter.next();
    }
    // Only the inline mark survives; the wholeLine diagnostic paints nothing.
    expect(out).toEqual([{ from: 10, to: 14, cls: "quoll-lint-mark-warning" }]);
  });

  it("diagnosticsAt uses a half-open hit-test [from, to)", () => {
    const ds: LintDiagnostic[] = [
      { from: 3, to: 6, severity: "warning", code: "no-trailing-spaces", message: "m" },
    ];
    expect(diagnosticsAt(ds, 2)).toHaveLength(0); // before from
    expect(diagnosticsAt(ds, 3)).toHaveLength(1); // at from -> included
    expect(diagnosticsAt(ds, 5)).toHaveLength(1); // inside
    expect(diagnosticsAt(ds, 6)).toHaveLength(0); // at to -> excluded (half-open)
  });

  it("diagnosticsAt matches a zero-length wholeLine diagnostic at its line start", () => {
    const ds: LintDiagnostic[] = [
      {
        from: 4,
        to: 4,
        severity: "info",
        code: "no-multiple-blanks",
        message: "m",
        wholeLine: true,
      },
    ];
    expect(diagnosticsAt(ds, 4)).toHaveLength(1); // at the line start -> hit
    expect(diagnosticsAt(ds, 3)).toHaveLength(0); // off the line start -> miss
  });

  it("diagnosticsAt hits a whitespace-spanning wholeLine diagnostic across its inclusive range", () => {
    const ds: LintDiagnostic[] = [
      {
        from: 3,
        to: 6,
        severity: "info",
        code: "no-multiple-blanks",
        message: "m",
        wholeLine: true,
      },
    ];
    expect(diagnosticsAt(ds, 3)).toHaveLength(1); // line start
    expect(diagnosticsAt(ds, 5)).toHaveLength(1); // mid-whitespace
    expect(diagnosticsAt(ds, 6)).toHaveLength(1); // inclusive content end
    expect(diagnosticsAt(ds, 7)).toHaveLength(0); // next line -> miss
  });

  it("re-anchors a held wholeLine diagnostic through an unrelated edit (no flicker)", () => {
    const state = stateFor("a\n\n\nb\n"); // blank lines at offsets 2 and 3
    const withDiag = state.update({
      effects: setLintDiagnostics.of([
        {
          from: 3,
          to: 3,
          severity: "info",
          code: "no-multiple-blanks",
          message: "x",
          wholeLine: true,
        },
      ]),
    }).state;
    // Append at EOF: the blank-line anchor at 3 is unaffected and must SURVIVE the
    // debounce-window mapping (the old `from < to` guard dropped all zero-length).
    const after = withDiag.update({ changes: { from: withDiag.doc.length, insert: "c\n" } }).state;
    const wl = after.field(lintField).filter((d) => d.wholeLine);
    expect(wl).toHaveLength(1);
    expect(wl[0]!.from).toBe(3);
    expect(wl[0]!.to).toBe(3);
  });

  it("drops a held wholeLine diagnostic whose mapped offset stops being a line start", () => {
    const state = stateFor("aa\n\nbb\n"); // blank line at offset 3
    const withDiag = state.update({
      effects: setLintDiagnostics.of([
        {
          from: 3,
          to: 3,
          severity: "info",
          code: "no-multiple-blanks",
          message: "x",
          wholeLine: true,
        },
      ]),
    }).state;
    // Delete the newline ending "aa" (index 2): the blank line merges into "aa" and
    // its mapped anchor (offset 2) is mid-line, no longer a line start -> dropped.
    const after = withDiag.update({ changes: { from: 2, to: 3, insert: "" } }).state;
    expect(after.field(lintField).some((d) => d.wholeLine)).toBe(false);
  });

  it("maps held diagnostics through a doc change so stale ranges stay in-bounds", () => {
    const state = stateFor("# Title\n\n### Skip\n"); // heading-increment over the "### Skip" node
    const before = state.field(lintField).find((d) => d.code === "heading-increment")!;
    expect(before.from).toBe(9);
    // Insert 3 chars at the start: the held diagnostic must shift +3 with NO re-lint
    // (debounced), and its mapped range must still point at "### Skip" and stay in-bounds.
    const next = state.update({ changes: { from: 0, insert: "xxx" } }).state;
    const after = next.field(lintField).find((d) => d.code === "heading-increment")!;
    expect(after.from).toBe(12);
    expect(after.to).toBeLessThanOrEqual(next.doc.length);
    expect(next.sliceDoc(after.from, after.to)).toBe("### Skip");
  });

  it("drops a held diagnostic whose range the edit collapses", () => {
    const state = stateFor("# Title\n\n### Skip\n");
    const heading = state.field(lintField).find((d) => d.code === "heading-increment")!;
    // Delete the whole flagged heading range: the mapped range collapses -> dropped.
    const next = state.update({
      changes: { from: heading.from, to: heading.to, insert: "" },
    }).state;
    expect(next.field(lintField).some((d) => d.code === "heading-increment")).toBe(false);
  });
});

describe("quollLint debounced recompute (view-level)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-lints after the debounce window and dispatches no document change", () => {
    const view = new EditorView({
      doc: "# A\n\n## B\n", // clean
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      const headingFindings = () =>
        view.state.field(lintField).filter((d) => d.code === "heading-increment");
      expect(headingFindings()).toHaveLength(0);

      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n#### D\n" } });
      const docAfterEdit = view.state.sliceDoc();
      // The field is still stale right after the edit — recompute is debounced.
      expect(headingFindings()).toHaveLength(0);

      vi.advanceTimersByTime(300);
      // The debounced compute has now published the new diagnostics...
      expect(headingFindings()).toHaveLength(1);
      // ...via an effect only: the document is byte-identical to the user edit.
      expect(view.state.sliceDoc()).toBe(docAfterEdit);
    } finally {
      view.destroy();
    }
  });

  it("debounced incremental compute stays byte-identical to a full lintMarkdown", () => {
    // Drives the plugin's per-view incremental linter and asserts the published
    // field deep-equals a full-parse lintMarkdown of the same text. A finding-COUNT
    // check would miss an incremental/full divergence in a finding's range or
    // message; this pins the whole diagnostic set.
    //
    // TWO debounce cycles are required to actually exercise the incremental path:
    // at mount CM calls the plugin's constructor but NOT update(ViewUpdate), so no
    // timer is scheduled and prevBody stays null. The FIRST edit+advance fires a
    // pass with prevBody === null → the full-parse branch (this seeds prevTree).
    // Only the SECOND edit+advance runs with prevBody set → the incremental branch.
    // A single cycle would test only the full-parse fallback.
    const view = new EditorView({
      doc: "# A\n\n## B\n\npara text\n",
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      // Cycle 1 — seeds prevTree via the full-parse branch.
      view.dispatch({ changes: { from: view.state.doc.length, insert: "### C\n" } });
      vi.advanceTimersByTime(300);
      expect(view.state.field(lintField)).toEqual(lintMarkdown(view.state.doc.toString()));

      // Cycle 2 — prevBody/prevTree are now set, so this pass takes the INCREMENTAL
      // branch. A structural, multi-line edit: skipped heading + trailing spaces +
      // a blank run, so a divergence would surface across several rules.
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "#### D  \n\n\n\nmore   \n" },
      });
      vi.advanceTimersByTime(300);
      expect(view.state.field(lintField)).toEqual(lintMarkdown(view.state.doc.toString()));
    } finally {
      view.destroy();
    }
  });

  it("holds a wholeLine diagnostic in a mounted view without painting a line block", () => {
    // Blank line "" starts at offset 3 in "a\n\n\nb\n" (a@0, ""@2, ""@3, b@4). A
    // wholeLine diagnostic there is held in the field but emits NO in-editor
    // decoration (buildLintDecorations skips it), so the mounted view applies the
    // resulting decoration set fine and the finding stays available to the gutter /
    // Problems mirror / hover.
    const view = new EditorView({
      doc: "a\n\n\nb\n",
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      view.dispatch({
        effects: setLintDiagnostics.of([
          {
            from: 3,
            to: 3,
            severity: "info",
            code: "no-multiple-blanks",
            message: "x",
            wholeLine: true,
          },
        ]),
      });
      expect(view.state.field(lintField).some((d) => d.wholeLine)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("maps the underline DecorationSet through a doc change instead of leaving it stale or rebuilding", () => {
    // Pin lintDecorationsField's per-keystroke mapping: an inline mark published by a
    // fresh lint must FOLLOW an edit made inside the debounce window (no re-lint) —
    // the set is mapped through tr.changes, not left at its stale offset. If the
    // docChanged branch returned the set unmapped, the underline would stay at [6,11)
    // over the shifted text and this assertion would go red.
    const view = new EditorView({
      doc: "hello world\n",
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      view.dispatch({
        effects: setLintDiagnostics.of([
          { from: 6, to: 11, severity: "warning", code: "no-trailing-spaces", message: "m" },
        ]),
      });
      expect(lintMarkRanges(view)).toEqual([{ from: 6, to: 11, cls: "quoll-lint-mark-warning" }]);
      // Insert 3 chars at the very start — no timer advance, so no debounced re-lint.
      view.dispatch({ changes: { from: 0, insert: "xxx" } });
      expect(lintMarkRanges(view)).toEqual([{ from: 9, to: 14, cls: "quoll-lint-mark-warning" }]);
    } finally {
      view.destroy();
    }
  });

  it("does not throw when an edit merges a flagged blank line into the previous line", () => {
    const view = new EditorView({
      doc: "aa\n\nbb\n", // blank line at offset 3
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      view.dispatch({
        effects: setLintDiagnostics.of([
          {
            from: 3,
            to: 3,
            severity: "info",
            code: "no-multiple-blanks",
            message: "x",
            wholeLine: true,
          },
        ]),
      });
      // Merge the blank line into "aa": the held wholeLine anchor maps to offset 2
      // (mid-line) and must be dropped rather than mis-attributed to "aa"'s line
      // (the next debounced compute republishes the corrected set). Reaching the
      // assertion = the field mapping handled the off-line-start anchor cleanly.
      view.dispatch({ changes: { from: 2, to: 3, insert: "" } });
      expect(view.state.field(lintField).some((d) => d.wholeLine)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("lints after a wholesale reseed (production doc:'' -> applyDocument path)", () => {
    // The real editor mounts with doc:"" then reseeds via applyDocument's
    // wholesale 0..len replace (editor.ts). Initial diagnostics therefore arrive
    // one debounce window after the seed — acceptable for an advisory layer
    // (the doc just opened; there is no keystroke latency to protect here).
    const view = new EditorView({
      doc: "",
      parent: document.body,
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    try {
      expect(view.state.field(lintField)).toHaveLength(0); // empty seed -> nothing
      view.dispatch({ changes: { from: 0, to: 0, insert: "# A\n\n### C\n" } });
      expect(
        view.state.field(lintField).filter((d) => d.code === "heading-increment")
      ).toHaveLength(0); // debounced -> not yet
      vi.advanceTimersByTime(300);
      expect(
        view.state.field(lintField).filter((d) => d.code === "heading-increment")
      ).toHaveLength(1);
      expect(view.state.sliceDoc()).toBe("# A\n\n### C\n");
    } finally {
      view.destroy();
    }
  });
});

describe("toWireDiagnostics (offset → 0-based line/character)", () => {
  it("converts an absolute offset range to line/character", () => {
    // "# Title"(7) "\n"(8) "\n"(9 start of line idx 2) "### Skip"(9..17)
    const doc = Text.of(["# Title", "", "### Skip"]);
    const wire = toWireDiagnostics(doc, [
      { from: 9, to: 17, severity: "warning", code: "heading-increment", message: "m" },
    ]);
    expect(wire).toEqual<LintDiagnosticWire[]>([
      {
        startLine: 2,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 8,
        severity: "warning",
        code: "heading-increment",
        message: "m",
      },
    ]);
  });

  it("does not carry a reserved fix field onto the wire", () => {
    const doc = Text.of(["abc"]);
    const wire = toWireDiagnostics(doc, [
      {
        from: 0,
        to: 1,
        severity: "info",
        code: "no-trailing-spaces",
        message: "m",
        fix: { from: 0, to: 1, insert: "" },
      },
    ]);
    expect(Object.keys(wire[0]).sort()).toEqual(
      [
        "code",
        "endCharacter",
        "endLine",
        "message",
        "severity",
        "startCharacter",
        "startLine",
      ].sort()
    );
  });
});

describe("quollLint diagnostics publisher (sink)", () => {
  function viewWithSink(doc: string, sink: (d: readonly LintDiagnosticWire[]) => void) {
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage }), quollLint(sink)],
      }),
    });
  }

  it("does NOT fire the sink on mount; fires only on a setLintDiagnostics effect", () => {
    // The publisher skips the constructor-time fire: in production the editor
    // mounts with an empty doc and real content arrives via a host reseed
    // (docChange → debounced compute → setLintDiagnostics → publisher).
    // A mount-time post would be a redundant empty set during half-initialized mount.
    const sink = vi.fn();
    const view = viewWithSink("# Title\n\n### Skip\n", sink);
    try {
      // No synchronous fire on mount.
      expect(sink).not.toHaveBeenCalled();
      // Dispatching a setLintDiagnostics effect DOES call the sink.
      view.dispatch({
        effects: setLintDiagnostics.of([
          { from: 9, to: 17, severity: "warning", code: "heading-increment", message: "m" },
        ]),
      });
      expect(sink).toHaveBeenCalledTimes(1);
      const wire = sink.mock.calls[0][0] as LintDiagnosticWire[];
      const skip = wire.find((d) => d.code === "heading-increment");
      expect(skip).toBeDefined();
      expect(skip?.startLine).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("fires the sink on a setLintDiagnostics effect (fresh compute)", () => {
    const sink = vi.fn();
    const view = viewWithSink("x", sink);
    try {
      sink.mockClear();
      view.dispatch({
        effects: setLintDiagnostics.of([
          { from: 0, to: 1, severity: "warning", code: "no-trailing-spaces", message: "m" },
        ]),
      });
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0]).toHaveLength(1);
      expect((sink.mock.calls[0][0] as LintDiagnosticWire[])[0].startLine).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT fire the sink on a plain document change (no fresh compute)", () => {
    const sink = vi.fn();
    const view = viewWithSink("# Title\n\n### Skip\n", sink);
    try {
      sink.mockClear();
      view.dispatch({ changes: { from: 0, insert: "z" } });
      expect(sink).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("quollLint() with no sink still works (backward compatible)", () => {
    const state = EditorState.create({
      doc: "# Title\n\n### Skip\n",
      extensions: [markdown({ base: markdownLanguage }), quollLint()],
    });
    expect(state.field(lintField).some((d) => d.code === "heading-increment")).toBe(true);
  });
});
