import { beforeEach, describe, expect, it } from "vitest";

import { createCaretHandoffWiring } from "../../../src/extension/handoff/caret-handoff-wiring.js";
import type { StatusBarSlot, StatusBarSlots } from "../../../src/extension/status-bar.js";
// Relative import (NOT the "vscode" alias) so the symbol type-checks; vite
// resolves both to the same test/extension/vscode-stub.ts module instance, so
// the listener the wiring registers via its "vscode" import is the one
// fireActiveTextEditor drives.
import { fireActiveTextEditor, resetStubEditorListeners } from "../vscode-stub.js";

// The caret-handoff wiring's activeEditorSub (Quoll→text handoff) applies the
// tracked caret to a matching text editor that becomes active — UNLESS the
// context-handoff reveal armed the one-shot suppression latch, in which case it
// skips the apply so the reveal's line-range selection survives. This pins both
// arms directly, without a live VS Code host or the reveal's tab-model churn.

function makeSlot(): StatusBarSlot {
  return {
    text: "",
    show: (): void => undefined,
    hide: (): void => undefined,
    dispose: (): void => undefined,
  };
}

function makeSlots(): StatusBarSlots {
  return { caret: makeSlot(), eol: makeSlot(), language: makeSlot(), count: makeSlot() };
}

const DOC_URI = "file:///doc.md";
const LINES = ["line0", "line1", "line2"];

// Minimal TextDocument surface the wiring reads (uri / eol / languageId /
// getText / lineCount / lineAt). eol=1 mirrors vscode.EndOfLine.LF.
function makeDocument(): never {
  return {
    uri: { toString: () => DOC_URI },
    eol: 1,
    languageId: "markdown",
    version: 1,
    getText: () => `${LINES.join("\n")}\n`,
    lineCount: LINES.length,
    lineAt: (line: number) => ({ text: LINES[line] ?? "" }),
  } as never;
}

// Minimal WebviewPanel surface: `.active` + onDidChangeViewState.
function makeWebviewPanel(): never {
  return {
    active: false,
    onDidChangeViewState: () => ({ dispose: (): void => undefined }),
  } as never;
}

// A live text editor for the tracked doc; records whether its selection was set.
function makeEditor(): { editor: never; getSelection: () => unknown } {
  const state: { selection: unknown } = { selection: null };
  const editor = {
    document: {
      uri: { toString: () => DOC_URI },
      lineCount: LINES.length,
      lineAt: (line: number) => ({ text: LINES[line] ?? "" }),
    },
    get selection(): unknown {
      return state.selection;
    },
    set selection(value: unknown) {
      state.selection = value;
    },
    revealRange: (): void => undefined,
  } as never;
  return { editor, getSelection: () => state.selection };
}

function makeWiring(consumeRevealCaretSuppression: () => boolean) {
  return createCaretHandoffWiring({
    document: makeDocument(),
    webviewPanel: makeWebviewPanel(),
    statusBarSlots: makeSlots(),
    switchCaret: null,
    isDisposed: () => false,
    postCaretApply: () => undefined,
    dispatchViewStateVisible: () => undefined,
    consumeRevealCaretSuppression,
  });
}

describe("caret-handoff wiring: activeEditorSub reveal guard", () => {
  beforeEach(() => {
    resetStubEditorListeners();
  });

  it("applies the tracked caret on an ordinary activation (latch un-armed)", () => {
    const wiring = makeWiring(() => false);
    wiring.reportCaret({ line: 2, character: 3, selectedChars: 0 });

    const { editor, getSelection } = makeEditor();
    fireActiveTextEditor(editor);

    const selection = getSelection() as { active: { line: number; character: number } } | null;
    expect(selection).not.toBeNull();
    expect(selection?.active.line).toBe(2);
    expect(selection?.active.character).toBe(3);
  });

  it("skips the caret apply when the reveal armed the latch (keeps the reveal's selection)", () => {
    const wiring = makeWiring(() => true);
    wiring.reportCaret({ line: 2, character: 3, selectedChars: 0 });

    const { editor, getSelection } = makeEditor();
    fireActiveTextEditor(editor);

    // The tracker consumed the one-shot latch and did NOT set the editor's
    // selection — the reveal's line-range selection is left intact.
    expect(getSelection()).toBeNull();
  });

  it("does NOT consume the latch for a non-matching-uri editor (consume gated behind the uri match)", () => {
    // Pins the load-bearing ordering: consume() runs AFTER the uri match, so an
    // unrelated editor activating between arm() and the reveal's own activation
    // cannot eat the latch (which would let the reveal's activation collapse the
    // range — the exact regression this guards).
    let consumeCalls = 0;
    const wiring = makeWiring(() => {
      consumeCalls += 1;
      return true;
    });
    wiring.reportCaret({ line: 2, character: 3, selectedChars: 0 });

    // An editor for a DIFFERENT document activates first.
    const other = { document: { uri: { toString: () => "file:///other.md" } } } as never;
    fireActiveTextEditor(other);
    expect(consumeCalls).toBe(0); // latch not eaten by the unrelated editor

    // The reveal's own editor then activates and consumes → range preserved.
    const { editor, getSelection } = makeEditor();
    fireActiveTextEditor(editor);
    expect(consumeCalls).toBe(1);
    expect(getSelection()).toBeNull();
  });

  it("consumes the latch on the reveal activation even before any caret-report (consume before the null check)", () => {
    // Pins the other load-bearing ordering: consume() runs BEFORE the
    // lastKnownCaret null check, so the reveal's activation always drains the
    // latch even when no caret has been reported yet — otherwise it would strand
    // and wrongly skip the NEXT ordinary switch's restore.
    let consumeCalls = 0;
    // Construct the wiring for its subscription side-effect; no reportCaret →
    // lastKnownCaret stays null.
    makeWiring(() => {
      consumeCalls += 1;
      return true; // armed by the reveal
    });

    const { editor, getSelection } = makeEditor();
    fireActiveTextEditor(editor);
    expect(consumeCalls).toBe(1); // latch cleared despite the null caret
    expect(getSelection()).toBeNull();
  });

  it("is one-shot: an ordinary activation after a consumed reveal restores the caret", () => {
    let armed = true;
    const wiring = makeWiring(() => {
      // First call (the reveal) consumes → true; subsequent calls (ordinary
      // switches) → false, mirroring the real latch's read-and-clear.
      const was = armed;
      armed = false;
      return was;
    });
    wiring.reportCaret({ line: 2, character: 3, selectedChars: 0 });

    // Reveal activation → skipped.
    const first = makeEditor();
    fireActiveTextEditor(first.editor);
    expect(first.getSelection()).toBeNull();

    // Ordinary activation afterwards → caret applied.
    const second = makeEditor();
    fireActiveTextEditor(second.editor);
    const selection = second.getSelection() as {
      active: { line: number; character: number };
    } | null;
    expect(selection).not.toBeNull();
    expect(selection?.active.line).toBe(2);
    expect(selection?.active.character).toBe(3);
  });
});
