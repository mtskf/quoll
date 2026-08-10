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
// NON-VACUITY — two traps, both load-bearing:
//
// 1. Do not assert "returns false, doc unchanged". Removing the malformed-range
//    guard makes CodeMirror throw, and the fail-open catch turns that throw into
//    exactly that result — indistinguishable from the guard doing its job. Tests
//    here assert a signal the catch cannot fake: a bad fix is paired with a VALID
//    one and the valid fix is required to land, or transactions are counted.
//
// 2. Do not assume CodeMirror rejects an invalid change set. Measured against the
//    pinned @codemirror/state, only an out-of-range or inverted range throws.
//    Unsorted and overlapping specs are ACCEPTED (mapped and composed), and a
//    collapsed delete is dropped while the transaction still dispatches. So the
//    sort and the overlap skip are not crash prevention — they define the
//    first-wins semantics, and dropping them produces a successful dispatch with
//    the wrong bytes. That is what the byte assertions below catch, not a throw.
//    Getting this backwards invites a future "CM handles it anyway" cleanup that
//    would silently swap first-wins for sequential composition.
//
// Each guard has a test that goes red when the guard is removed; the boundary
// guards additionally have one that goes red when the comparison is broadened.
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
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
const { proseLintEnabled } = await import("../../../src/webview/cm/lint/extension.js");

// 11 chars: "abcdefghij" (line 1, span [0,10]) + "\n". With a caret at 0 every fix
// stubbed below — including the deliberately out-of-range ones — still intersects
// that span under the half-open overlap test in apply-fix.ts, so the selection
// filter never drops it and the change-set loop is what actually runs.
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
function apply(extras: Extension[] = []): { applied: boolean; doc: string; dispatches: number } {
  let dispatches = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(0),
      extensions: [
        EditorView.updateListener.of(() => {
          dispatches += 1;
        }),
        ...extras,
      ],
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
    // CodeMirror drops such a spec itself, but the transaction still fires — so
    // without the guard this returns true and Mod-. claims the chord for a change
    // that alters nothing. The bytes are identical either way; the transaction
    // count is the only signal that separates the two.
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
    // First-wins: "cdef" goes, "ghij" stays. Without the skip CodeMirror composes
    // both specs rather than throwing, deleting through to 8 — a successful
    // dispatch with the wrong bytes.
    expect(apply()).toEqual({ applied: true, doc: "abghij\n", dispatches: 1 });
  });

  it("applies both of two abutting fixes (touching is not overlapping)", () => {
    // Pins `f.from < lastTo` rather than `<=`: a fix starting exactly where the
    // previous one ended is a valid neighbour. Both stubbed fixes are valid and
    // both must land.
    stubFixes({ from: 2, to: 4, insert: "" }, { from: 4, to: 6, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "abghij\n", dispatches: 1 });
  });

  it("sorts unordered fixes into an ascending change set", () => {
    // Emitted back-to-front, both valid. CodeMirror would accept them unsorted,
    // so the sort is pinned through the overlap skip instead: unsorted, `lastTo`
    // becomes 8 from the [6,8) fix and the earlier [2,4) fix is mis-skipped,
    // losing "cd".
    stubFixes({ from: 6, to: 8, insert: "" }, { from: 2, to: 4, insert: "" });
    expect(apply()).toEqual({ applied: true, doc: "abefij\n", dispatches: 1 });
  });
});

describe("prose gate passthrough", () => {
  // The re-lint forwards the live facet: `lintMarkdown(doc, { prose: facet })`.
  // No prose rule emits a fix yet, so the unmocked suite cannot observe this
  // argument at all — a dropped `{ prose }` would leave a future prose fix
  // invisible to Mod-. while its underline showed, with a green suite. This spy
  // is the only place that contract can be pinned.
  it("forwards the prose gate to the engine (off by default)", () => {
    stubFixes({ from: 5, to: 6, insert: "" });
    apply();
    expect(lintMarkdown).toHaveBeenCalledWith(DOC, { prose: false });
  });

  it("forwards prose: true when the facet is on", () => {
    // Reads the facet rather than hard-coding false.
    stubFixes({ from: 5, to: 6, insert: "" });
    apply([proseLintEnabled.of(true)]);
    expect(lintMarkdown).toHaveBeenCalledWith(DOC, { prose: true });
  });
});

describe("fail-open catch", () => {
  it("returns false and logs instead of propagating an engine throw", () => {
    lintMarkdown.mockImplementation(() => {
      throw new Error("boom");
    });
    // Without the catch the throw propagates out of the command — into
    // CodeMirror's keymap dispatch in production.
    expect(apply()).toEqual({ applied: false, doc: DOC, dispatches: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      "[quoll] applyLintFixAtSelection failed",
      expect.any(Error)
    );
  });

  it("returns false and logs when the dispatch pipeline itself throws", () => {
    // The catch spans the dispatch too, and that arm is unreachable from any fix
    // descriptor once the guards hold: an out-of-range one is rejected by the
    // guards, NaN by the selection filter ahead of them, and a non-string insert
    // does not make CodeMirror throw at all. Its real trigger is the extension
    // pipeline a production dispatch runs, so pin it there.
    stubFixes({ from: 5, to: 6, insert: "" });
    const throwingPipeline = EditorState.transactionExtender.of(() => {
      throw new Error("pipeline boom");
    });
    expect(apply([throwingPipeline])).toEqual({ applied: false, doc: DOC, dispatches: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      "[quoll] applyLintFixAtSelection failed",
      expect.any(Error)
    );
  });

  it("forwards a non-Error throw to the log verbatim", () => {
    // `catch (err)` hands err straight to console.error with no property access,
    // so a thrown string must survive unchanged. Pins that against a future
    // "improve the log" edit reaching for err.message.
    lintMarkdown.mockImplementation(() => {
      // biome-ignore lint/style/useThrowOnlyError: the non-Error throw is the point
      throw "boom";
    });
    expect(apply()).toEqual({ applied: false, doc: DOC, dispatches: 0 });
    expect(consoleError).toHaveBeenCalledWith("[quoll] applyLintFixAtSelection failed", "boom");
  });
});
