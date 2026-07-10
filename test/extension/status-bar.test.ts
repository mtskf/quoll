import { describe, expect, it } from "vitest";
import {
  createStatusBarController,
  type EndOfLineValue,
  formatCaretPosition,
  formatEol,
  formatLanguageLabel,
  resolveSeedCaret,
  type StatusBarSlot,
  type StatusBarSlots,
} from "../../src/extension/status-bar.js";

describe("formatCaretPosition", () => {
  it("renders a 0-based caret as VS Code's 1-based Ln/Col label", () => {
    expect(formatCaretPosition({ line: 0, character: 0 })).toBe("Ln 1, Col 1");
    expect(formatCaretPosition({ line: 4, character: 9 })).toBe("Ln 5, Col 10");
  });
});

describe("formatEol", () => {
  it("maps vscode.EndOfLine values (1 = LF, 2 = CRLF)", () => {
    expect(formatEol(1)).toBe("LF");
    expect(formatEol(2)).toBe("CRLF");
  });
});

describe("formatLanguageLabel", () => {
  it("capitalises the language id (markdown -> Markdown)", () => {
    expect(formatLanguageLabel("markdown")).toBe("Markdown");
  });

  it("passes an empty id through unchanged", () => {
    expect(formatLanguageLabel("")).toBe("");
  });
});

describe("resolveSeedCaret", () => {
  it("prefers the stashed toggle caret over the last-known caret", () => {
    expect(resolveSeedCaret({ line: 7, character: 2 }, { line: 3, character: 5 })).toEqual({
      line: 7,
      character: 2,
    });
  });

  it("falls back to the last-known caret when there is no toggle caret", () => {
    expect(resolveSeedCaret(null, { line: 3, character: 5 })).toEqual({
      line: 3,
      character: 5,
    });
  });

  it("falls back to the document origin when both are null", () => {
    expect(resolveSeedCaret(null, null)).toEqual({ line: 0, character: 0 });
  });
});

// Fake slot that records text writes and show/hide/dispose calls so the
// controller's fan-out is observable without a live vscode.StatusBarItem.
function makeSlot() {
  const calls: string[] = [];
  const slot: StatusBarSlot = {
    text: "",
    show: () => calls.push("show"),
    hide: () => calls.push("hide"),
    dispose: () => calls.push("dispose"),
  };
  return { slot, calls };
}

function makeSlots() {
  const caret = makeSlot();
  const eol = makeSlot();
  const language = makeSlot();
  const slots: StatusBarSlots = {
    caret: caret.slot,
    eol: eol.slot,
    language: language.slot,
  };
  return { slots, caret, eol, language };
}

describe("createStatusBarController", () => {
  it("seeds all three slots at construction (no blank item before first update)", () => {
    const { slots, caret, eol, language } = makeSlots();
    const crlf: EndOfLineValue = 2;
    createStatusBarController(slots, {
      view: { caret: { line: 2, character: 3 }, eol: crlf },
      languageLabel: "Markdown",
    });
    expect(caret.slot.text).toBe("Ln 3, Col 4");
    expect(eol.slot.text).toBe("CRLF");
    expect(language.slot.text).toBe("Markdown");
  });

  it("update() refreshes caret + EOL but leaves the static language label", () => {
    const { slots, caret, eol, language } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1 },
      languageLabel: "Markdown",
    });
    c.update({ caret: { line: 9, character: 0 }, eol: 1 });
    expect(caret.slot.text).toBe("Ln 10, Col 1");
    expect(eol.slot.text).toBe("LF");
    expect(language.slot.text).toBe("Markdown");
  });

  it("show / hide / dispose fan out to every slot", () => {
    const { slots, caret, eol, language } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1 },
      languageLabel: "Markdown",
    });
    c.show();
    c.hide();
    c.dispose();
    for (const s of [caret, eol, language]) {
      expect(s.calls).toEqual(["show", "hide", "dispose"]);
    }
  });
});
