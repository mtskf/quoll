// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { setLintDiagnostics } from "../../src/webview/cm/lint/extension.js";
import { lintGutterLineMarks, quollLintGutter } from "../../src/webview/cm/lint/gutter.js";
import { quollLint } from "../../src/webview/cm/lint/index.js";
import type { LintDiagnostic } from "../../src/webview/cm/lint/types.js";

const doc = Text.of(["line one", "line two", "line three"]);
// line starts: 0, 9, 18 (each line + "\n")

function diag(from: number, to: number, severity: "warning" | "info"): LintDiagnostic {
  return { from, to, severity, code: "x", message: "m" };
}

describe("lintGutterLineMarks", () => {
  it("returns one entry per line that has a finding, keyed by line start", () => {
    const marks = lintGutterLineMarks(doc, [diag(2, 5, "info"), diag(10, 12, "warning")]);
    expect([...marks.keys()].sort((a, b) => a - b)).toEqual([0, 9]);
    expect(marks.get(0)).toBe("info");
    expect(marks.get(9)).toBe("warning");
  });

  it("collapses multiple findings on one line to the highest severity", () => {
    const marks = lintGutterLineMarks(doc, [diag(0, 2, "info"), diag(3, 5, "warning")]);
    expect(marks.size).toBe(1);
    expect(marks.get(0)).toBe("warning");
  });

  it("keeps warning when warning precedes info on the same line", () => {
    const marks = lintGutterLineMarks(doc, [diag(0, 2, "warning"), diag(3, 5, "info")]);
    expect(marks.get(0)).toBe("warning");
  });

  it("returns an empty map for no diagnostics", () => {
    expect(lintGutterLineMarks(doc, []).size).toBe(0);
  });
});

describe("quollLintGutter (view-level toggle via Compartment)", () => {
  function viewWith(text: string) {
    const compartment = new Compartment();
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [markdown({ base: markdownLanguage }), quollLint(), compartment.of([])],
      }),
    });
    return { view, compartment };
  }

  it("mounts the .quoll-lint-gutter only when the compartment holds the gutter", () => {
    // trailing space + heading skip -> findings on lines 1 & 3
    const { view, compartment } = viewWith("# Title \n\n### Skip\n");

    // Off: our gutter is absent. PRIMARY assertion is `.quoll-lint-gutter`
    // (NOT `.cm-gutters`): a future second gutter would leave `.cm-gutters`
    // present even with our gutter off, making a `.cm-gutters` check a false
    // positive (Codex review finding 7).
    expect(view.dom.querySelector(".quoll-lint-gutter")).toBeNull();
    // Secondary (PR-LOCAL): this PR ships no other gutter, so the entire
    // `.cm-gutters` wrapper is also absent when off — this directly pins the
    // default-off "pixel-identical reading column" guarantee. If a future PR
    // adds a second gutter, DELETE this one line; `.quoll-lint-gutter` above
    // stays the durable contract (Codex review finding 3).
    expect(view.dom.querySelector(".cm-gutters")).toBeNull();

    // On: reconfigure the compartment to mount the gutter.
    view.dispatch({ effects: compartment.reconfigure(quollLintGutter()) });
    expect(view.dom.querySelector(".quoll-lint-gutter")).not.toBeNull();

    // Off again: our gutter is removed.
    view.dispatch({ effects: compartment.reconfigure([]) });
    expect(view.dom.querySelector(".quoll-lint-gutter")).toBeNull();

    view.destroy();
  });

  it("renders/updates dots from a setLintDiagnostics effect (no doc change)", () => {
    // Start empty so there are NO findings, gutter ON. This pins the core
    // premise — the gutter tracks lintField updates that arrive as an EFFECT
    // carrying no document change (Codex review finding 3); the whole opt-in
    // gutter rests on `markers(view)` re-running on such a transaction.
    const { view, compartment } = viewWith("x");
    const docBefore = view.state.sliceDoc();
    view.dispatch({ effects: compartment.reconfigure(quollLintGutter()) });
    expect(view.dom.querySelector(".quoll-lint-gutter-dot")).toBeNull();
    // Display-only contract: mounting the gutter never mutates the document
    // (guards against a stray `changes` ever entering setLintGutter — Codex review).
    expect(view.state.sliceDoc()).toBe(docBefore);

    // Publish a warning on line 0 via the effect — NO doc change.
    view.dispatch({
      effects: setLintDiagnostics.of([
        { from: 0, to: 1, severity: "warning", code: "manual", message: "m" },
      ]),
    });
    expect(view.dom.querySelector(".quoll-lint-gutter-dot-warning")).not.toBeNull();
    expect(view.dom.querySelector(".quoll-lint-gutter-dot-info")).toBeNull();

    // Replace with an info finding — the dot severity flips, still no doc change.
    view.dispatch({
      effects: setLintDiagnostics.of([
        { from: 0, to: 1, severity: "info", code: "manual", message: "m" },
      ]),
    });
    expect(view.dom.querySelector(".quoll-lint-gutter-dot-info")).not.toBeNull();
    expect(view.dom.querySelector(".quoll-lint-gutter-dot-warning")).toBeNull();

    // Clear all findings — the dot disappears.
    view.dispatch({ effects: setLintDiagnostics.of([]) });
    expect(view.dom.querySelector(".quoll-lint-gutter-dot")).toBeNull();

    // Display-only contract still holds after every reconfigure + lint effect.
    expect(view.state.sliceDoc()).toBe(docBefore);

    view.destroy();
  });
});
