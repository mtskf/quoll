import { describe, expect, it } from "vitest";
import {
  countCharacters,
  countWords,
  createStatusBarController,
  type EndOfLineValue,
  estimateReadingMinutes,
  formatCaretPosition,
  formatDocumentStats,
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

  it("omits the selection suffix when selectedChars is 0 / absent", () => {
    expect(formatCaretPosition({ line: 4, character: 9 }, 0)).toBe("Ln 5, Col 10");
    // A negative count (defensive) is treated as no selection.
    expect(formatCaretPosition({ line: 4, character: 9 }, -1)).toBe("Ln 5, Col 10");
  });

  it("appends ` (N selected)` for a non-empty primary selection", () => {
    expect(formatCaretPosition({ line: 28, character: 1551 }, 147)).toBe(
      "Ln 29, Col 1552 (147 selected)"
    );
    expect(formatCaretPosition({ line: 0, character: 0 }, 1)).toBe("Ln 1, Col 1 (1 selected)");
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
    expect(
      resolveSeedCaret({
        switchCaret: { line: 7, character: 2 },
        lastKnownCaret: { line: 3, character: 5 },
      })
    ).toEqual({
      line: 7,
      character: 2,
    });
  });

  it("falls back to the last-known caret when there is no toggle caret", () => {
    expect(
      resolveSeedCaret({ switchCaret: null, lastKnownCaret: { line: 3, character: 5 } })
    ).toEqual({
      line: 3,
      character: 5,
    });
  });

  it("falls back to the document origin when both are null", () => {
    expect(resolveSeedCaret({ switchCaret: null, lastKnownCaret: null })).toEqual({
      line: 0,
      character: 0,
    });
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
  const count = makeSlot();
  const slots: StatusBarSlots = {
    caret: caret.slot,
    eol: eol.slot,
    language: language.slot,
    count: count.slot,
  };
  return { slots, caret, eol, language, count };
}

describe("countCharacters", () => {
  it("returns the raw document length (not prose-filtered)", () => {
    expect(countCharacters("")).toBe(0);
    expect(countCharacters("hello")).toBe(5);
    // Frontmatter + code are counted here — char count is document size.
    expect(countCharacters("---\na: 1\n---\n`code`")).toBe("---\na: 1\n---\n`code`".length);
  });
});

describe("countWords", () => {
  it("counts whitespace-delimited alphanumeric tokens", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
    expect(countWords("one two three")).toBe(3);
    expect(countWords("hello,   world\nagain")).toBe(3);
  });

  it("ignores bare Markdown punctuation tokens", () => {
    // The `#`, `-`, `>` and `|` tokens carry no alphanumeric → not words.
    expect(countWords("# Heading here")).toBe(2);
    expect(countWords("- item one\n- item two")).toBe(4);
    expect(countWords("> quote\n\n| a | b |")).toBe(3);
  });

  it("excludes YAML frontmatter from the word count", () => {
    expect(countWords("---\ntitle: My Post\ntags: a b c\n---\nBody words here")).toBe(3);
  });

  it("leaves an unterminated frontmatter opener intact (over-count over swallow)", () => {
    // No closing fence → not treated as frontmatter; `title` + `My` + `Post` count.
    expect(countWords("---\ntitle: My Post")).toBe(3);
  });

  it("excludes fenced code blocks (``` and ~~~)", () => {
    expect(countWords("before\n```js\nconst x = 1\n```\nafter")).toBe(2);
    expect(countWords("before\n~~~\nsome code here\n~~~\nafter")).toBe(2);
  });

  it("excludes an unterminated fence through end-of-document", () => {
    expect(countWords("before\n```\ndangling code never closes")).toBe(1);
  });

  it("does not let a mismatched fence marker close a code block", () => {
    // A ~~~ line inside a ``` block (and the symmetric case) must NOT close it —
    // the closer must match the opener's marker char, so the inner content stays
    // code and only the trailing prose ("after") counts.
    expect(countWords("```\n~~~\ncode words here\n```\nafter")).toBe(1);
    expect(countWords("~~~\n```\ncode words here\n~~~\nafter")).toBe(1);
  });

  it("strips frontmatter closed by a `...` marker", () => {
    expect(countWords("---\ntitle: My Post\n...\nBody words here")).toBe(3);
  });

  it("strips frontmatter in a CRLF document", () => {
    expect(countWords("---\r\ntitle: My Post\r\n---\r\nBody words here")).toBe(3);
  });

  it("counts a space-free CJK run as one word (documented v1 limitation)", () => {
    expect(countWords("日本語のテキスト")).toBe(1);
    expect(countWords("日本語 の テキスト")).toBe(3); // spaces still delimit
  });
});

describe("estimateReadingMinutes", () => {
  it("is words / 200 rounded up, 0 words → 0 min", () => {
    expect(estimateReadingMinutes(0)).toBe(0);
    expect(estimateReadingMinutes(1)).toBe(1);
    expect(estimateReadingMinutes(200)).toBe(1);
    expect(estimateReadingMinutes(201)).toBe(2);
    expect(estimateReadingMinutes(1000)).toBe(5);
  });
});

describe("formatDocumentStats", () => {
  it("renders words · chars · reading-time with singular/plural nouns", () => {
    expect(formatDocumentStats("")).toBe("0 words · 0 chars · 0 min read");
    expect(formatDocumentStats("a")).toBe("1 word · 1 char · 1 min read");
    expect(formatDocumentStats("one two")).toBe("2 words · 7 chars · 1 min read");
  });

  it("groups large counts with thousands separators", () => {
    const text = `${"word ".repeat(1500)}`; // 1500 words, 7500 chars
    expect(formatDocumentStats(text)).toBe("1,500 words · 7,500 chars · 8 min read");
  });
});

describe("createStatusBarController", () => {
  it("seeds all four slots at construction (no blank item before first update)", () => {
    const { slots, caret, eol, language, count } = makeSlots();
    const crlf: EndOfLineValue = 2;
    createStatusBarController(slots, {
      view: { caret: { line: 2, character: 3 }, eol: crlf, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "one two three",
    });
    expect(caret.slot.text).toBe("Ln 3, Col 4");
    expect(eol.slot.text).toBe("CRLF");
    expect(language.slot.text).toBe("Markdown");
    expect(count.slot.text).toBe("3 words · 13 chars · 1 min read");
  });

  it("update() refreshes caret + EOL but leaves the static language label", () => {
    const { slots, caret, eol, language } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "",
    });
    c.update({ caret: { line: 9, character: 0 }, eol: 1, selectedChars: 0 });
    expect(caret.slot.text).toBe("Ln 10, Col 1");
    expect(eol.slot.text).toBe("LF");
    expect(language.slot.text).toBe("Markdown");
  });

  it("update() leaves the count slot untouched (only updateCount re-scans)", () => {
    const { slots, count } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "one two three",
    });
    expect(count.slot.text).toBe("3 words · 13 chars · 1 min read");
    c.update({ caret: { line: 9, character: 0 }, eol: 1, selectedChars: 0 });
    // A selection/caret refresh must NOT re-scan the document.
    expect(count.slot.text).toBe("3 words · 13 chars · 1 min read");
  });

  it("updateCount() re-renders the count slot from fresh text", () => {
    const { slots, count } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "",
    });
    expect(count.slot.text).toBe("0 words · 0 chars · 0 min read");
    c.updateCount("hello world");
    expect(count.slot.text).toBe("2 words · 11 chars · 1 min read");
  });

  it("update() wires a non-empty selectedChars into the caret slot text", () => {
    const { slots, caret } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "",
    });
    c.update({ caret: { line: 9, character: 0 }, eol: 1, selectedChars: 5 });
    expect(caret.slot.text).toBe("Ln 10, Col 1 (5 selected)");
    // Collapsing back to 0 drops the suffix.
    c.update({ caret: { line: 9, character: 0 }, eol: 1, selectedChars: 0 });
    expect(caret.slot.text).toBe("Ln 10, Col 1");
  });

  it("show / hide / dispose fan out to every slot", () => {
    const { slots, caret, eol, language, count } = makeSlots();
    const c = createStatusBarController(slots, {
      view: { caret: { line: 0, character: 0 }, eol: 1, selectedChars: 0 },
      languageLabel: "Markdown",
      documentText: "",
    });
    c.show();
    c.hide();
    c.dispose();
    for (const s of [caret, eol, language, count]) {
      expect(s.calls).toEqual(["show", "hide", "dispose"]);
    }
  });
});
