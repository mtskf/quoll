// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { type Command, EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLintFixAtSelection,
  LINT_FIX_KEY,
  quollLintFixKeymap,
} from "../../../src/webview/cm/lint/apply-fix.js";
import { lintMarkdown } from "../../../src/webview/cm/lint/engine.js";
import { quollLint } from "../../../src/webview/cm/lint/extension.js";

// `selection` mirrors CodeMirror's EditorStateConfig.selection type: `cursor()`
// returns a SelectionRange (the `{ anchor, head }` shape), while `single()` /
// `create()` return an EditorSelection.
function viewFor(
  doc: string,
  selection?: EditorSelection | { anchor: number; head?: number },
  readOnly = false
): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        markdown({ base: markdownLanguage }),
        quollLint(),
        quollLintFixKeymap(),
        // Mirror the production editor (editor.ts) so the multi-cursor test
        // realises both ranges — CM collapses a multi-range selection to its
        // main range without this facet, which would silently defeat the test.
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ],
    }),
    parent: document.body,
  });
}

describe("applyLintFixAtSelection", () => {
  it("pins the keybinding", () => {
    expect(LINT_FIX_KEY).toBe("Mod-.");
  });

  it("trims a single trailing space when the caret is on the line", () => {
    const view = viewFor("foo \nbar\n", EditorSelection.cursor(0)); // caret on line 1
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo\nbar\n");
    } finally {
      view.destroy();
    }
  });

  it("trims a trailing tab", () => {
    const view = viewFor("foo\t\nbar\n", EditorSelection.cursor(0));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo\nbar\n");
    } finally {
      view.destroy();
    }
  });

  it("trims with the caret AT the end of the trailing run (most common case)", () => {
    // Caret right after typing the spaces: head == diagnostic.to. Line-span
    // scoping (not a covers-caret hit-test) makes this work.
    const view = viewFor("foo   ", EditorSelection.cursor(6));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo");
    } finally {
      view.destroy();
    }
  });

  it("fixes every flagged line covered by a multi-line selection", () => {
    const doc = "foo \nbar \nbaz\n";
    const view = viewFor(doc, EditorSelection.single(0, doc.length));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo\nbar\nbaz\n");
    } finally {
      view.destroy();
    }
  });

  it("does NOT fix the next line when the selection only ends at its start", () => {
    // Selecting line 1 + its newline ends the (half-open) range at line 2's
    // start; line 2's trailing space must be left alone. Pins the
    // `r.empty ? r.to : r.to - 1` line-end calc (Codex round-2 #1).
    const doc = "foo \nbar \n";
    const view = viewFor(doc, EditorSelection.single(0, 5)); // 0 .. "b" of "bar"
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo\nbar \n"); // only line 1 trimmed
    } finally {
      view.destroy();
    }
  });

  it("fixes each line under a multi-cursor selection without duplicate changes", () => {
    const doc = "foo \nbar \n";
    const view = viewFor(
      doc,
      EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(5)])
    );
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("foo\nbar\n");
    } finally {
      view.destroy();
    }
  });

  it("returns false and changes nothing when no fixable diagnostic is in scope", () => {
    const doc = "clean\nbar \n"; // trailing space is on line 2, caret on line 1
    const view = viewFor(doc, EditorSelection.cursor(0));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc); // byte-identical
    } finally {
      view.destroy();
    }
  });

  it("returns false on a fully clean document", () => {
    const doc = "foo\nbar\n";
    const view = viewFor(doc, EditorSelection.cursor(0));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("respects the current rule conditions via fresh re-lint (two spaces = hard break, no fix)", () => {
    // A terminated line with exactly two trailing spaces is a Markdown hard break,
    // NOT flagged. Re-linting fresh at apply time means the command sees this and
    // does nothing — even if a stale underline were still showing.
    const doc = "foo  \nbar\n";
    const view = viewFor(doc, EditorSelection.cursor(0));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT apply heading-increment (no fix descriptor)", () => {
    const doc = "# Title\n\n### Skip\n";
    const view = viewFor(doc, EditorSelection.single(0, doc.length));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT mutate a read-only document (returns false)", () => {
    const doc = "foo \nbar\n";
    const view = viewFor(doc, EditorSelection.cursor(0), /* readOnly */ true);
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc); // byte-identical — never mutated
    } finally {
      view.destroy();
    }
  });

  it("collapses a blank-line run to one blank with the caret on the excess line", () => {
    const doc = "a\n\n\nb\n"; // a@0, ""@2 (allowed), ""@3 (excess, flagged)
    const view = viewFor(doc, EditorSelection.cursor(3));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("a\n\nb\n");
    } finally {
      view.destroy();
    }
  });

  it("does NOT collapse a blank run with the caret at the start of the clean line below", () => {
    // a@0, ""@2 (allowed), ""@3 (excess, flagged, fix=[3,4)). Caret at 4 = column 0
    // of the clean content line "b". The caret only touches the fix at its exclusive
    // `to`, so it must NOT trigger the blank-line deletion (half-open overlap).
    const doc = "a\n\n\nb\n";
    const view = viewFor(doc, EditorSelection.cursor(4));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc); // byte-identical
    } finally {
      view.destroy();
    }
  });

  it("collapses a 3-blank run to exactly one blank under a full-run selection", () => {
    const doc = "a\n\n\n\nb\n"; // a@0, ""@2 (allowed), ""@3 ""@4 (excess, flagged)
    const view = viewFor(doc, EditorSelection.single(0, doc.length));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("a\n\nb\n");
    } finally {
      view.destroy();
    }
  });

  it("returns false on a document with only single blank lines", () => {
    const doc = "a\n\nb\n\nc\n";
    const view = viewFor(doc, EditorSelection.single(0, doc.length));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc); // byte-identical
    } finally {
      view.destroy();
    }
  });

  it("collapses a run whose excess final blank line has no own terminator (EOF)", () => {
    const doc = "a\n\n   "; // ""@2 (allowed), "   "@3 (excess, no own terminator)
    const view = viewFor(doc, EditorSelection.cursor(3));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("a\n\n"); // exactly one blank line survives
    } finally {
      view.destroy();
    }
  });

  it("does NOT touch consecutive blank lines inside a fenced code block (caret in-fence)", () => {
    // ```js@0, "let x = 1;"@6, ""@17 (in-fence, would-be-allowed), ""@18
    // (in-fence, would-be-excess but exempt), "let y = 2;"@19, "```"@30. The rule
    // never emits a fix for an in-code-block blank, so the real command must be a
    // byte-identical no-op with the caret sitting on the exempt line.
    const doc = "```js\nlet x = 1;\n\n\nlet y = 2;\n```\n";
    const view = viewFor(doc, EditorSelection.cursor(18));
    try {
      expect(applyLintFixAtSelection(view)).toBe(false);
      expect(view.state.sliceDoc()).toBe(doc); // byte-identical
    } finally {
      view.destroy();
    }
  });

  it("collapses only the pre-fence excess blank, leaving in-fence blanks untouched", () => {
    // a@0, ""@2 (allowed), ""@3 (pre-fence excess, flagged), ```@4, ""@8
    // (in-fence, allowed), ""@9 (in-fence, would-be-excess but exempt), code@10,
    // ```@15. A full-selection fix must collapse only the pre-fence run.
    const doc = "a\n\n\n```\n\n\ncode\n```\n";
    const view = viewFor(doc, EditorSelection.single(0, doc.length));
    try {
      expect(applyLintFixAtSelection(view)).toBe(true);
      expect(view.state.sliceDoc()).toBe("a\n\n```\n\n\ncode\n```\n");
    } finally {
      view.destroy();
    }
  });
});

describe("quollLintFixKeymap precedence", () => {
  // Pins the Prec.high claim in apply-fix.ts: Quoll's Mod-. must be tried before a
  // competing Mod-. binding at default precedence (the stand-in for one being added
  // to upstream's defaultKeymap). The competitor is registered FIRST, so at equal
  // precedence it would win by registration order — dropping Prec.high turns the
  // first case red (competitor called, doc untrimmed).
  function precedenceView(doc: string, competitor: Command): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [
          Prec.default(keymap.of([{ key: LINT_FIX_KEY, run: competitor }])),
          markdown({ base: markdownLanguage }),
          quollLint(),
          quollLintFixKeymap(),
        ],
      }),
      parent: document.body,
    });
  }

  /** Press the chord under BOTH platform normalisations of `Mod-` (Meta on mac,
   *  Ctrl elsewhere) and return how many presses were claimed. CM resolves `Mod-`
   *  once, from a platform probe that happy-dom answers non-deterministically, so a
   *  single-variant press is flaky (memory
   *  `[[quoll-cm-keymap-test-runscopehandlers-platform-flaky]]`). Exactly one variant
   *  matches on any platform — the count assertion below pins that, so the pair can
   *  never silently degrade into "neither fired, nothing was tested". */
  function pressBothModVariants(view: EditorView): number {
    return [{ ctrlKey: true }, { metaKey: true }]
      .map((mods) =>
        runScopeHandlers(
          view,
          new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true, ...mods }),
          "editor"
        )
      )
      .filter(Boolean).length;
  }

  it("runs the fix command before a competing default-precedence Mod-. binding", () => {
    const competitor = vi.fn<Command>(() => true);
    const view = precedenceView("foo \n", competitor);
    try {
      expect(pressBothModVariants(view)).toBe(1);
      expect(competitor).not.toHaveBeenCalled();
      expect(view.state.sliceDoc()).toBe("foo\n"); // Quoll's command claimed the chord
    } finally {
      view.destroy();
    }
  });

  it("falls through to the competing binding when nothing is fixable", () => {
    // The other half of the contract: winning the race is not the same as owning the
    // chord. Returning false on a clean line hands Mod-. to whoever is next.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const competitor = vi.fn<Command>(() => true);
    const view = precedenceView("clean\n", competitor);
    try {
      expect(pressBothModVariants(view)).toBe(1);
      expect(competitor).toHaveBeenCalledTimes(1);
      expect(view.state.sliceDoc()).toBe("clean\n"); // byte-identical
      // The fall-through must be a decision, not a swallowed failure: this command
      // fails open, so a throw produces the same false / no-dispatch / unchanged-doc
      // observation as "nothing was fixable". The log is what tells them apart.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("no fix runs without the explicit user action", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("computing/debouncing diagnostics never mutates the document", () => {
    // Build a doc that IS flagged: trailing space + trailing tab.
    const flagged = "foo \nbar\t\n";
    const view = viewFor(flagged, EditorSelection.cursor(0));
    try {
      // The fix descriptors exist for this doc...
      expect(lintMarkdown(flagged).filter((d) => d.fix).length).toBeGreaterThan(0);
      // ...but nothing applies them. Edit + advance the debounce window: still
      // byte-for-byte what the user typed, never auto-trimmed.
      view.dispatch({ changes: { from: view.state.doc.length, insert: "baz \n" } });
      vi.advanceTimersByTime(300);
      expect(view.state.sliceDoc()).toBe("foo \nbar\t\nbaz \n");
    } finally {
      view.destroy();
    }
  });
});
