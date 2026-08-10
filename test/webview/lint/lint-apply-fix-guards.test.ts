// @vitest-environment happy-dom
//
// Change-set validity guards + fail-open catch in applyLintFixAtSelection.
//
// Separate file from lint-apply-fix.test.ts because these tests STUB the lint
// engine: no first-party rule emits a malformed, collapsed, overlapping, or
// unsorted fix today, so the guards are a forward contract for future rules and
// are unreachable from real rule output. Driving them needs a fake diagnostic
// set. The module-level `vi.mock` here would also blind the real-rule suite, so
// that suite stays in its own (unmocked) file.
//
// NON-VACUITY: "returns false, doc unchanged" is a vacuous assertion here — it is
// exactly what the fail-open catch produces when a guard is missing and `dispatch`
// throws on the invalid change set. So each test asserts a signal the catch cannot
// fake: the malformed/overlap/sort cases pair the bad fix with a VALID one and
// require the valid fix to land, and the collapsed case counts transactions (an
// unguarded no-op change still dispatches and still returns true). Every test below
// was verified red against both removal AND over-broadening of its guard.
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LintDiagnostic } from "../../../src/webview/cm/lint/types.js";

const lintMarkdown = vi.hoisted(() =>
  vi.fn<(raw: string, options?: unknown) => LintDiagnostic[]>()
);

// Spread the real module: apply-fix.ts pulls `proseLintEnabled` from
// extension.ts, which imports other engine exports. Only `lintMarkdown` is faked.
vi.mock("../../../src/webview/cm/lint/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/webview/cm/lint/engine.js")>()),
  lintMarkdown,
}));

const { applyLintFixAtSelection } = await import("../../../src/webview/cm/lint/apply-fix.js");

// 11 chars: "abcdefghij" (line 1, span [0,10]) + "\n". A caret at 0 puts every
// offset used below inside the in-scope line span, so each test exercises the
// change-set loop rather than the selection filter.
const DOC = "abcdefghij\n";

type FixSpec = { from: number; to: number; insert: string };

/** A fixable diagnostic carrying `fix` verbatim. `from`/`to`/`severity`/`code`
 *  are inert here — only `fix` reaches the change-set loop. */
function diag(fix: FixSpec): LintDiagnostic {
  return {
    from: Math.max(0, fix.from),
    to: Math.max(0, fix.from),
    severity: "warning",
    code: "no-trailing-spaces",
    message: "stub",
    fix,
  };
}

/** Stub the engine's return for the next apply call. */
function stubFixes(...fixes: FixSpec[]): void {
  lintMarkdown.mockReturnValue(fixes.map(diag));
}

/** Run the command against a caret-at-0 view and report what it did. The
 *  transaction count separates "skipped the fix" from "dispatched a change that
 *  happens to alter no bytes" — the collapsed-delete guard's whole point. */
function apply(): { applied: boolean; doc: string; dispatches: number } {
  let dispatches = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(0),
      extensions: [EditorView.updateListener.of(() => (dispatches += 1))],
    }),
    parent: document.body,
  });
  try {
    return { applied: applyLintFixAtSelection(view), doc: view.state.sliceDoc(), dispatches };
  } finally {
    view.destroy();
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lintMarkdown.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("malformed-fix guard", () => {
  it("skips a fix starting before the document while a valid sibling still applies", () => {
    stubFixes({ from: -1, to: 1, insert: "" }, { from: 5, to: 6, insert: "" });
    // Only "f" is deleted; the negative-`from` fix never reaches the change set.
    expect(apply()).toEqual({ applied: true, doc: "abcdeghij\n", dispatches: 1 });
  });

  it("skips a fix ending past the document while a valid sibling still applies", () => {
    stubFixes({ from: 0, to: 1, insert: "" }, { from: 5, to: 99, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "bcdefghij\n", dispatches: 1 });
  });

  it("skips an inverted fix (from > to) while a valid sibling still applies", () => {
    stubFixes({ from: 0, to: 1, insert: "" }, { from: 8, to: 3, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "bcdefghij\n", dispatches: 1 });
  });

  it("accepts a fix touching both document ends (the guard is inclusive)", () => {
    // from === 0 and to === doc.length are legal, not malformed — pins `< 0` /
    // `> docLength` rather than `<= 0` / `>= docLength`.
    stubFixes({ from: 0, to: DOC.length, insert: "z" });
    expect(apply()).toEqual({ applied: true, doc: "z", dispatches: 1 });
  });
});

describe("collapsed-delete guard", () => {
  it("returns false without dispatching when the only fix is a zero-length delete", () => {
    stubFixes({ from: 5, to: 5, insert: "" });
    // Without the guard this dispatches a no-op transaction and returns true,
    // making Mod-. claim the chord for a change that alters nothing.
    expect(apply()).toEqual({ applied: false, doc: DOC, dispatches: 0 });
  });

  it("still applies a zero-length fix that inserts text", () => {
    // Pins `from === to && insert === ""` rather than `from === to`: a pure
    // insertion is a legitimate fix shape.
    stubFixes({ from: 5, to: 5, insert: "X" });
    expect(apply()).toEqual({ applied: true, doc: "abcdeXfghij\n", dispatches: 1 });
  });
});

describe("overlap guard and sort", () => {
  it("keeps the first of two overlapping fixes and drops the second", () => {
    stubFixes({ from: 2, to: 6, insert: "" }, { from: 4, to: 8, insert: "" });
    // First-wins: "cdef" goes, "ghij" stays.
    expect(apply()).toEqual({ applied: true, doc: "abghij\n", dispatches: 1 });
  });

  it("applies both of two abutting fixes (touching is not overlapping)", () => {
    // Pins `f.from < lastTo` rather than `<=`: a fix starting exactly where the
    // previous one ended is a valid neighbour.
    stubFixes({ from: 2, to: 4, insert: "" }, { from: 4, to: 6, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "abghij\n", dispatches: 1 });
  });

  it("sorts unordered fixes into an ascending change set", () => {
    // Emitted back-to-front. Unsorted, CodeMirror rejects the change set.
    stubFixes({ from: 6, to: 8, insert: "" }, { from: 2, to: 4, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "abefij\n", dispatches: 1 });
  });
});

describe("fail-open catch", () => {
  it("returns false and logs instead of propagating an engine throw", () => {
    lintMarkdown.mockImplementation(() => {
      throw new Error("boom");
    });
    // Without the catch the throw escapes the command into CodeMirror's keymap
    // handler and this call rejects.
    expect(apply()).toEqual({ applied: false, doc: DOC, dispatches: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      "[quoll] applyLintFixAtSelection failed",
      expect.any(Error)
    );
  });
});
