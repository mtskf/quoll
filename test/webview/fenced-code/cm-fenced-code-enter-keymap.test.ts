// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

// Spy on ensureSyntaxTree so the lazy-parse tests below can assert the command
// never forces a parse to EOF on a non-trigger Enter. The mock preserves every
// other export (the language setup constructs `new Language(...)` etc.) and
// delegates ensureSyntaxTree to the real implementation, so behaviour is intact.
vi.mock("@codemirror/language", async (importActual) => {
  const actual = await importActual<typeof import("@codemirror/language")>();
  return { ...actual, ensureSyntaxTree: vi.fn(actual.ensureSyntaxTree) };
});

import { ensureSyntaxTree, forceParsing } from "@codemirror/language";

import {
  autoCloseFenceOnEnter,
  fencedCodeEnterKeymap,
} from "../../../src/webview/cm/fenced-code/fenced-code-enter-keymap.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";

function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean; withHistory?: boolean; withKeymap?: boolean } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      quollMarkdownLanguage(),
      EditorState.readOnly.of(opts.readOnly ?? false),
      ...(opts.withHistory ? [history()] : []),
      ...(opts.withKeymap ? [fencedCodeEnterKeymap()] : []),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

/** Cursor at the END of 1-based line `n`. */
function endOfLine(view: EditorView, n: number): SelectionRange {
  return EditorSelection.cursor(view.state.doc.line(n).to);
}

/** Move the caret to the end of 1-based line `n` (post-mount, once the doc is
 *  known). Returns the view for chaining. */
function caretAtEndOf(view: EditorView, n: number): EditorView {
  view.dispatch({ selection: endOfLine(view, n) });
  return view;
}

describe("autoCloseFenceOnEnter — trigger cases", () => {
  it("closes a lone ``` opener at EOF (empty body, caret between the fences)", () => {
    const view = caretAtEndOf(mount("```", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
      expect(view.state.doc.line(2).text).toBe("");
    } finally {
      view.destroy();
    }
  });

  it("closes an opener above content — the rest is NOT swallowed into the block", () => {
    const view = caretAtEndOf(mount("```\nhello\nworld", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello\nworld");
      // "hello"/"world" are now OUTSIDE the fenced block (line 3 is the closer).
      expect(view.state.doc.line(3).text).toBe("```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    } finally {
      view.destroy();
    }
  });

  it("keeps the language tag on the opener and closes with a BARE fence", () => {
    const view = caretAtEndOf(mount("```ruby\nputs 1", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```ruby\n\n```\nputs 1");
      expect(view.state.doc.line(1).text).toBe("```ruby");
      expect(view.state.doc.line(3).text).toBe("```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    } finally {
      view.destroy();
    }
  });

  it("matches the opener's fence LENGTH (4 backticks → 4-backtick closer)", () => {
    const view = caretAtEndOf(mount("````\ntext", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("````\n\n````\ntext");
    } finally {
      view.destroy();
    }
  });

  it("closes a blockquote-prefixed fence with a matching `> ` closer", () => {
    const view = caretAtEndOf(mount("> ```ruby\n> body", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("> ```ruby\n> \n> ```\n> body");
      expect(view.state.doc.line(3).text).toBe("> ```");
      // Caret at end of the "> " body line (after the prefix).
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
    } finally {
      view.destroy();
    }
  });

  it("closes a list-indented fence at the content column (no new list item)", () => {
    // A fence indented under a list item (leading spaces = content column).
    const view = caretAtEndOf(mount("- item\n  ```\n  code", EditorSelection.cursor(0)), 2);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- item\n  ```\n  \n  ```\n  code");
      expect(view.state.doc.line(4).text).toBe("  ```");
    } finally {
      view.destroy();
    }
  });

  it("triggers with the caret at the START of the opener line (not just at line end)", () => {
    // Caret at column 0 — before the fence run. resolving at the caret head would
    // land in Document (not FencedCode); the command probes the line END instead.
    const view = mount("```ruby\nputs 1", EditorSelection.cursor(0));
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```ruby\n\n```\nputs 1");
    } finally {
      view.destroy();
    }
  });
});

describe("autoCloseFenceOnEnter — non-trigger guards (return false, doc unchanged)", () => {
  it("does NOT trigger for inline `` `code` `` (no FencedCode ancestor)", () => {
    const doc = "a `code` b";
    const view = mount(doc, EditorSelection.cursor(4)); // inside the inline code
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger from inside the block BODY of an unclosed fence", () => {
    const doc = "```\nbody\nmore";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // on "body"
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger on an ALREADY-CLOSED opener (a closer already follows)", () => {
    const doc = "```\ncode\n```";
    const view = caretAtEndOf(mount(doc, EditorSelection.cursor(0)), 1); // on the opener line
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger in a plain paragraph", () => {
    const doc = "just prose";
    const view = mount(doc, EditorSelection.cursor(4));
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger on a read-only doc", () => {
    const view = caretAtEndOf(mount("```", EditorSelection.cursor(0), { readOnly: true }), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("```");
    } finally {
      view.destroy();
    }
  });
});

describe("autoCloseFenceOnEnter — history + keymap wiring", () => {
  it("is ONE undo step — a single undo reverts the whole auto-close", () => {
    const view = caretAtEndOf(
      mount("```\nhello", EditorSelection.cursor(0), { withHistory: true }),
      1
    );
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\nhello");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers auto-closes an opener (keymap wires Enter → command)", () => {
    const view = caretAtEndOf(
      mount("```\nhello", EditorSelection.cursor(0), { withKeymap: true }),
      1
    );
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers is NOT handled in a plain paragraph (falls through)", () => {
    const view = mount("plain", EditorSelection.cursor(3), { withKeymap: true });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(false);
      expect(view.state.doc.toString()).toBe("plain");
    } finally {
      view.destroy();
    }
  });

  it("exports exactly the command + the keymap factory", async () => {
    const mod = await import("../../../src/webview/cm/fenced-code/fenced-code-enter-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(["autoCloseFenceOnEnter", "fencedCodeEnterKeymap"]);
  });
});

// A `.md` opened in the editor is not force-parsed to EOF; the command runs on
// EVERY Enter. The lazy-parse contract: decide fence membership from a parse
// bounded to the caret line, and only extend past it when the caret line is
// actually a fenced-block opener (whose extent the parser must resolve anyway).
// A plain-paragraph Enter must NOT force a parse to end-of-document.
describe("autoCloseFenceOnEnter — lazy parse (no EOF parse on non-triggers)", () => {
  // Mount WITHOUT forceParse — a fresh, mostly-unparsed large doc, mirroring a
  // just-opened file where an eager EOF parse would stall.
  function mountUnparsed(doc: string, caret: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [quollMarkdownLanguage()],
    });
    return new EditorView({ state, parent });
  }

  // A large doc whose line 1 is a small paragraph (blank line after it) followed
  // by a big body — so a bounded parse to line 1 is cheap while an EOF parse is not.
  function bigProseDoc(): string {
    const body = Array.from({ length: 6000 }, (_, i) => `para ${i}\n`).join("\n");
    return `first paragraph line\n\n${body}`;
  }

  it("plain-paragraph Enter never forces a parse to EOF (bounds to the caret line)", () => {
    const spy = vi.mocked(ensureSyntaxTree);
    const view = mountUnparsed(bigProseDoc(), 3); // caret on line 1 (prose)
    const caretLineTo = view.state.doc.lineAt(3).to;
    const docLength = view.state.doc.length;
    spy.mockClear();
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      const toArgs = spy.mock.calls.map((c) => c[1]);
      // The command DID consult the parser (bounded to the caret line)…
      expect(toArgs).toContain(caretLineTo);
      // …but NEVER forced it to EOF — the regression this guards against.
      expect(toArgs).not.toContain(docLength);
      expect(caretLineTo).toBeLessThan(docLength);
    } finally {
      view.destroy();
    }
  });

  it("a caret in the BODY of an unclosed fence never REQUESTS an EOF parse", () => {
    // A body caret is a non-trigger (rejected by the opener-line guard). This pins
    // that the command bounds its OWN ensureSyntaxTree request to the caret line —
    // it is not the thing forcing an EOF parse. (Note: for an UNCLOSED fence the
    // parser must scan to EOF regardless to resolve the block's extent, so no
    // bounded-parse perf win exists for this rare transient state; the contract
    // here is only "the command doesn't request doc.length", not "no EOF scan".)
    const spy = vi.mocked(ensureSyntaxTree);
    const body = Array.from({ length: 6000 }, (_, i) => `text ${i}\n`).join("\n");
    const view = mountUnparsed(`\`\`\`\nfirst body line\n\n${body}`, 0);
    const bodyLine = view.state.doc.line(2); // "first body line"
    view.dispatch({ selection: EditorSelection.cursor(bodyLine.to) });
    const docLength = view.state.doc.length;
    spy.mockClear();
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      const toArgs = spy.mock.calls.map((c) => c[1]);
      expect(toArgs).not.toContain(docLength);
    } finally {
      view.destroy();
    }
  });

  it("does NOT misfire on an already-closed opener with a distant closer (fresh doc)", () => {
    // The load-bearing correctness claim under the bounded parse: a FencedCode node
    // is only emitted once its extent is resolved, so its CodeMark children are
    // complete even on a fresh, un-force-parsed doc. Here the closer sits thousands
    // of lines below the opener; the already-closed guard (marks.length >= 2) must
    // still see BOTH marks and refuse — no duplicate closer inserted. (The other
    // already-closed test force-parses via mount(); this one deliberately does not,
    // exercising the lazy path the fix relies on.)
    const bigBody = Array.from({ length: 4000 }, (_, i) => `code ${i}`).join("\n");
    const trailing = Array.from({ length: 4000 }, (_, i) => `after ${i}`).join("\n");
    const doc = `\`\`\`ruby\n${bigBody}\n\`\`\`\n${trailing}`;
    const view = mountUnparsed(doc, 0);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to) }); // opener line
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc); // unchanged — no duplicate closer
    } finally {
      view.destroy();
    }
  });

  it("still fires on a genuine unclosed opener (fence behaviour unchanged)", () => {
    const view = mountUnparsed("```ruby\nputs 1", 0);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to) });
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```ruby\n\n```\nputs 1");
    } finally {
      view.destroy();
    }
  });
});
