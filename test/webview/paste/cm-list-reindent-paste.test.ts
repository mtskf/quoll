// @vitest-environment happy-dom
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { listReindentPaste, reindentPastedList } from "../../../src/webview/cm/paste/index.js";

describe("reindentPastedList — pure transform", () => {
  it("re-bases a top-level list fragment to the destination column (delta +2)", () => {
    const frag = "- top\n  - child\n- top2";
    // destColumn 2, marker-min indent 0 → delta +2
    expect(reindentPastedList(frag, 2, 2)).toBe("  - top\n    - child\n  - top2");
  });

  it("preserves inner relative structure when de-denting (delta -2)", () => {
    const frag = "  - a\n    - b\n  - c";
    // destColumn 0, marker-min indent 2 → delta -2
    expect(reindentPastedList(frag, 0, 2)).toBe("- a\n  - b\n- c");
  });

  it("shifts a genuine continuation line with the item (stays below its marker)", () => {
    const frag = "- item\n  more text\n- next";
    // "more text" (col 2) is a non-marker continuation >= marker-min (0) → kept.
    expect(reindentPastedList(frag, 2, 2)).toBe("  - item\n    more text\n  - next");
  });

  it("recognises ordered-list markers as a list fragment", () => {
    expect(reindentPastedList("1. a\n2. b", 2, 2)).toBe("  1. a\n  2. b");
  });

  it("preserves a trailing newline", () => {
    expect(reindentPastedList("- a\n- b\n", 2, 2)).toBe("  - a\n  - b\n");
  });

  it("leaves a blank line inside the fragment blank (no indentation injected)", () => {
    expect(reindentPastedList("- a\n\n- b", 2, 2)).toBe("  - a\n\n  - b");
  });

  it("returns null for a single-line fragment (defer)", () => {
    expect(reindentPastedList("- only", 4, 2)).toBeNull();
  });

  it("returns null when the first non-blank line is not a list marker (defer)", () => {
    expect(reindentPastedList("plain text\nmore text", 4, 2)).toBeNull();
  });

  it("returns null when the fragment opens with a blank line (not a clean list block)", () => {
    expect(reindentPastedList("\n- x\n  - y", 2, 2)).toBeNull();
  });

  it("returns null when the fragment contains a fenced code block (defer, byte-identical)", () => {
    // v1 fail-closed: a fence-bearing fragment is inserted unchanged, so its code
    // lines round-trip byte-identical. Re-basing around a fence is out of scope.
    expect(reindentPastedList("- a\n  ```\n  code\n  ```\n- b", 2, 2)).toBeNull();
    expect(reindentPastedList("- a\n  ~~~js\n  x\n  ~~~", 4, 2)).toBeNull();
  });

  it("returns null when a non-marker line is shallower than the list markers (ambiguous)", () => {
    // "child" (col 0) is a flush-left non-list line below "  - a" (marker col 2):
    // not a clean list block → defer rather than pick a wrong base column.
    expect(reindentPastedList("  - a\nchild", 0, 2)).toBeNull();
  });

  it("returns null when a structural line's leading whitespace contains a TAB (ambiguous)", () => {
    expect(reindentPastedList("- a\n\t- b", 2, 4)).toBeNull();
  });

  it("re-emits unchanged text when delta is zero (still non-null — the handler swallows the prefix)", () => {
    // delta 0 must NOT defer: the handler's prefix-swallow still needs to run, or
    // the caret line's existing indentation would double-count the first line.
    expect(reindentPastedList("- a\n  - b", 0, 2)).toBe("- a\n  - b");
    expect(reindentPastedList("  - a\n    - b", 2, 2)).toBe("  - a\n    - b");
  });
});

// --- Handler ---

function mount(doc: string, canWrite = true) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown(),
        EditorState.readOnly.of(!canWrite),
        listReindentPaste({ canWrite: () => canWrite }),
      ],
    }),
  });
}

function firePaste(view: EditorView, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

// NOTE on defer assertions (repo convention — see cm-paste-url-link.test.ts):
// on a DEFER our handler returns `false`, so CM's OWN core paste handler runs and
// calls preventDefault() itself → `event.defaultPrevented` is an UNRELIABLE defer
// signal. The behavioural contract for a defer is "no re-base happened", asserted
// on document CONTENT: the re-based-only fingerprint "    - y" (the second line at
// column 4, which only our transform produces) must be ABSENT. On ACCEPT we
// preventDefault (CM core does not run), so exact-content assertions are safe.

describe("listReindentPaste — handler", () => {
  // Fixture note: the caret sits at the end of the blank interior line "  " of a
  // LOOSE item "b" (which has a following continuation "  more"), col 2. A blank
  // interior line resolves via `listItemAt` (a bare TRAILING blank line does not
  // — verified with the grammar), so this is the reliable in-list, line-start,
  // nothing-after-caret position the feature targets.
  const LOOSE = "- a\n  - b\n  \n  more";
  const CARET = "- a\n  - b\n  ".length; // 12 — end of the blank "  " interior line

  it("re-bases a list fragment pasted at the indented caret of a nested item", () => {
    const view = mount(LOOSE);
    view.dispatch({ selection: { anchor: CARET } });
    firePaste(view, "- x\n  - y");
    // Prefix "  " swallowed; "- x" lands at col 2, "  - y" (col 2 in frag) at col 4.
    expect(view.state.doc.toString()).toBe("- a\n  - b\n  - x\n    - y\n  more");
    view.destroy();
  });

  it("swallows the caret prefix even when no re-indent is needed (delta 0)", () => {
    // Fragment top already at col 2; delta 0 must still swallow the "  " prefix so
    // the first line lands at col 2, not col 4 (would double-indent if deferred).
    const view = mount(LOOSE);
    view.dispatch({ selection: { anchor: CARET } });
    firePaste(view, "  - x\n    - y");
    expect(view.state.doc.toString()).toBe("- a\n  - b\n  - x\n    - y\n  more");
    view.destroy();
  });

  it("defers when the caret line prefix is not whitespace-only (never glue mid-line)", () => {
    // Caret at end of "  - b" — prefix "  - b" contains the marker → defer.
    const view = mount("- a\n  - b");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    firePaste(view, "- x\n  - y");
    expect(view.state.doc.toString()).not.toContain("    - y"); // no re-base
    view.destroy();
  });

  it("defers when the spaces-only caret is NOT in a list context", () => {
    // "  " under a paragraph is a lazy continuation, not a list → defer.
    const view = mount("para\n  ");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    firePaste(view, "- x\n  - y");
    expect(view.state.doc.toString()).not.toContain("    - y");
    view.destroy();
  });

  it("defers when the selection is non-empty (selection paste → default paste)", () => {
    const view = mount("- a\n  - b\n  ");
    // Select the trailing two spaces (non-empty range) — must defer.
    view.dispatch({
      selection: { anchor: view.state.doc.length - 2, head: view.state.doc.length },
    });
    firePaste(view, "- x\n  - y");
    expect(view.state.doc.toString()).not.toContain("    - y");
    view.destroy();
  });

  it("defers when the caret prefix contains a TAB (does not rewrite indentation)", () => {
    const view = mount("- a\n\t");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    firePaste(view, "- x\n  - y");
    const doc = view.state.doc.toString();
    expect(doc).not.toContain("    - y"); // no re-base
    expect(doc).toContain("\t"); // tab indentation preserved, not rewritten to spaces
    view.destroy();
  });

  it("defers a single-line paste inside a list (nothing to re-base)", () => {
    const view = mount("- a\n  ");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    firePaste(view, "just text");
    // Our handler never fired (single-line gate) → it did NOT swallow the "  "
    // prefix, so the caret line's leading spaces survive regardless of whether
    // CM's core paste inserted anything. (Avoids asserting CM-core insert in happy-dom.)
    expect(view.state.doc.toString()).toContain("- a\n  ");
    view.destroy();
  });

  it("swallows the paste in a read-only editor without inserting", () => {
    // Read-only ACCEPT path (same in-list caret as the happy path): the handler
    // preventDefaults then swallows (no insert), so the doc is unchanged.
    const view = mount(LOOSE, false);
    view.dispatch({ selection: { anchor: CARET } });
    firePaste(view, "- x\n  - y");
    expect(view.state.doc.toString()).toBe(LOOSE);
    view.destroy();
  });
});
