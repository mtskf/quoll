// @vitest-environment happy-dom
//
// ⚠️ REQUIRED as the first line. vitest.config.ts sets `environment: "node"`
// globally (`:31`), so without this docblock every DOM operation in the mount
// fails and the suite dies on the harness. editor.test.ts:1 carries the same line.
//
// The line-model guard for ARCH-01a. What it protects: Quoll never provides
// `EditorState.lineSeparator`, so CodeMirror keeps its default insert splitter
// `/\r\n?|\n/` — which handles every line ending — and a multi-line STRING
// insert splits into real lines whatever the document's own EOL is. The
// document's EOL lives in Quoll's own `quollDocumentEol` facet instead, and is
// applied only on the way OUT (`serializeDocument`).
//
// Why it is worth a suite of its own: providing that facet downgrades the
// splitter to a literal split on the facet's value, so a bare `\n` pasted into a
// CRLF document — or a `\r\n` into an LF one — survives as ONE CM line carrying
// a literal separator inside its text. Quoll did provide it until this change,
// and six insert paths plus several of CodeMirror's own were corrupt. It went
// unnoticed because a corrupt document and a correct one share a `length` AND a
// `toString()`; only `Text.eq` differs (see
// `.claude/plans/arch-01a-lf-only-cm-interior.md`, "Measured facts"). These
// tests therefore assert the LINE MODEL, never the flattened string.
import { copyLineDown, undo } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { replaceNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoCloseFenceOnEnter } from "../../src/webview/cm/fenced-code/fenced-code-enter-keymap.js";
import { addPendingAnchor } from "../../src/webview/cm/image/image-paste.js";
import { continueListOnEnter } from "../../src/webview/cm/list/list-continuation-keymap.js";
import { quollDocumentEol } from "../../src/webview/cm/seed.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { initialState } from "../../src/webview/state.js";
import { firePasteAt } from "./helpers/clipboard-double.js";

const postMessage = vi.fn();
/** Only `edit` posts — orthogonal `lint-diagnostics` traffic must not invalidate
 *  assertions about Edit bytes. Mirrors editor.test.ts:46-47, which is
 *  module-local and therefore cannot be imported. */
const editPosts = () =>
  postMessage.mock.calls.map((c) => c[0]).filter((m) => (m as { type?: string })?.type === "edit");

// ⚠️ All FOUR exports are required, not just the two this suite calls. The real
// mount constructs the outline ViewPlugin (outline-panel.ts:1064), whose
// constructor reaches createResizeHandle -> readPersistedState()
// (resize-handle.ts:270), and a vitest factory mock THROWS on a missing export —
// so a two-export mock makes mount() itself fail and the suite goes red on the
// harness instead of on the behaviour under test. editor.test.ts:49-54 carries
// all four for exactly this reason.
vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: () => () => {},
  readPersistedState: () => ({}),
  patchPersistedState: () => {},
}));

const mounted: EditorHandle[] = [];
let container: HTMLElement | null = null;

beforeEach(() => {
  postMessage.mockClear();
  // ⚠️ The container must be CREATED here, not just declared. mount() passes it
  // to mountEditor as `parent`, and editor.ts:277 calls `opts.parent.appendChild`
  // — a null parent throws before any assertion runs, so the suite would again
  // fail on the harness rather than on the behaviour. Mirrors editor.test.ts:84-88.
  container = document.createElement("div");
  document.body.appendChild(container);
});

// ⚠️ Load-bearing, not hygiene: an undisposed editor keeps a live updateListener
// whose edit-sync debounce (DEBOUNCE_MS = 300, a REAL setTimeout in tests that do
// not install fake timers) outlives the test and posts a stray Edit into the next
// test's freshly reset postMessage trail. That cross-test leak made the full
// parallel suite non-deterministically red once already — see editor.test.ts:57-64
// and :90-105. Dispose BEFORE useRealTimers so dispose()'s clearTimeout runs in the
// same timer context the debounce was scheduled in.
afterEach(() => {
  for (const handle of mounted.splice(0)) {
    handle.dispose();
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount() {
  const state = { ...initialState, ready: true, docVersion: 1, canWrite: true };
  const handle = mountEditor({
    parent: container as HTMLElement,
    nonce: "test-nonce",
    getState: () => state,
    dispatch: () => {},
  });
  mounted.push(handle);
  const mountEl = container?.querySelector(".quoll-editor") as HTMLElement | null;
  if (!mountEl) {
    throw new Error("Editor mount node missing");
  }
  const view = EditorView.findFromDOM(mountEl);
  if (!view) {
    throw new Error("EditorView not found via findFromDOM");
  }
  return {
    handle,
    view,
    commit(editInFlight: boolean) {
      handle.onReducerCommit(editInFlight);
    },
  };
}

/** Assert the LINE MODEL, not the flattened string.
 *
 *  ⚠️ `toString()` cannot see this bug: a document whose line text carries a
 *  literal `\n` has the same `length` AND the same `toString()` as the correct
 *  one — only `Text.eq` differs (measured 2026-09-22). */
function expectLineModel(doc: Text, expected: readonly string[]): void {
  expect(doc.lines).toBe(expected.length);
  expect(Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text)).toEqual(
    expected as string[]
  );
}

/** The cause-independent invariant: no line's text may contain a separator.
 *
 *  This is the guard. A pin on `EditorState.lineSeparator` being unset names the
 *  one cause this suite was written for, but it cannot see a hand-built
 *  `Text.of(["x\ny"])` or a `ChangeSet.of(spec, len, "\r\n")` prepared with an
 *  explicit separator — both corrupt a facet-less state while that pin stays
 *  green (measured). This assertion is blind to the mechanism: it states what
 *  "clean line model" MEANS, so anything that breaks it on an exercised path
 *  reds.
 *
 *  ⚠️ It deliberately does NOT also round-trip through the serializer. That
 *  check cannot fail when this one passes: with no separator inside any line,
 *  joining with either EOL and re-splitting on `/\r\n?|\n/` reproduces the same
 *  lines, so it is EOL-independent and says nothing about outbound bytes.
 *  Outbound bytes are asserted separately — at the wire, in the last describe
 *  block below, and over every fixture in test/markdown/round-trip.test.ts.
 *
 *  Honest scope: this protects the paths this suite exercises. It is not a proof
 *  that every future insert path goes red. */
function expectCleanLineModel(doc: Text): void {
  for (let n = 1; n <= doc.lines; n++) {
    expect(doc.line(n).text).toMatch(/^[^\r\n]*$/);
  }
}

describe("the guard itself", () => {
  it("rejects a malformed document (negative control)", () => {
    expect(() => expectCleanLineModel(Text.of(["x\ny"]))).toThrow();
    expect(() => expectCleanLineModel(Text.of(["ax\r", "y"]))).toThrow();
    expectCleanLineModel(Text.of(["x", "y"])); // and accepts a clean one
  });
});

describe("Quoll's own multi-line insert paths, in a CRLF document", () => {
  it("Enter mid-list keeps a clean line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("- first\r\n- second", true, 1);
    // A reseed posts nothing (editor.test.ts (r4) pins this) — sanity check that
    // seeding this fixture is not itself an observable Edit before we drive Enter.
    expect(editPosts()).toHaveLength(0);
    view.dispatch({ selection: EditorSelection.cursor(7) }); // end of "- first"
    expect(continueListOnEnter(view)).toBe(true);
    expectLineModel(view.state.doc, ["- first", "- ", "- second"]);
    expect(view.state.selection.main.head).toBe(10);
    expectCleanLineModel(view.state.doc);
  });

  it("autoCloseFenceOnEnter keeps a clean line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("```js\r\nx", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(5) }); // end of "```js"
    expect(autoCloseFenceOnEnter(view)).toBe(true);
    expectCleanLineModel(view.state.doc);
  });

  it("htmlTablePaste keeps a clean line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("intro\r\ntext", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    firePasteAt(view.contentDOM, {
      html: "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    });
    // The insert LANDED — without this, expectCleanLineModel alone is true of a
    // document nothing happened to, so a handler that never fires passes.
    expectLineModel(view.state.doc, [
      "intro",
      "text",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ]);
    expectCleanLineModel(view.state.doc);
  });

  it("richHtmlPaste keeps a clean line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("intro\r\ntext", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    firePasteAt(view.contentDOM, { html: "<ul><li>one</li><li>two</li></ul>" });
    expectLineModel(view.state.doc, ["intro", "text", "", "- one", "- two", ""]);
    expectCleanLineModel(view.state.doc);
  });

  it("listReindentPaste keeps a clean line model", () => {
    const { handle, view } = mount();
    // Fixture mirrors cm-list-reindent-paste.test.ts's LOOSE fixture: the caret
    // sits at the end of the blank interior line "  " of a loose nested item,
    // the reliable in-list, line-start, nothing-after-caret position the
    // feature targets.
    handle.applyDocument("- a\r\n  - b\r\n  \r\n  more", true, 1);
    const caret = "- a\n  - b\n  ".length; // interior is LF-only regardless of source EOL
    view.dispatch({ selection: { anchor: caret } });
    firePasteAt(view.contentDOM, { text: "- x\n  - y" });
    // Reindented to the caret's depth — proves the reindent handler ran, not
    // just that the document stayed well-formed.
    expectLineModel(view.state.doc, ["- a", "  - b", "  - x", "    - y", "  more"]);
    expectCleanLineModel(view.state.doc);
  });

  it("imagePaste (resolveImageWrite) keeps a clean line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("ab\r\ncd", true, 1);
    // Anchor mid-line so the insert carries the leading "\n" (image-paste.ts's
    // standalone-block prefix), exercising the multi-line insert path.
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    handle.resolveImageWrite("1", "./assets/x.png");
    expectLineModel(view.state.doc, ["a", "![](./assets/x.png)", "b", "cd"]);
    expectCleanLineModel(view.state.doc);
  });

  it("runFormatDocument over a multi-row table keeps a clean line model", () => {
    // Format used to carry its own EOL join — the one site in the webview that
    // did — and dispatched a pre-joined string. It no longer does
    // (format-document-command.ts): its multi-line insert takes the same
    // default-splitter path as every other insert here. This pin is what makes
    // that equivalence observable, so re-introducing a bespoke join for a CRLF
    // document reds.
    const { handle, view } = mount();
    handle.applyDocument("| a | bbbb |\r\n| - | - |\r\n| 1 | 2 |\r\n", true, 1);
    handle.runFormatDocument();
    expectCleanLineModel(view.state.doc);
    expect(view.state.doc.lines).toBe(4);
  });
});

describe("CodeMirror's own multi-line insert paths, in a CRLF document", () => {
  it("plain paste of LF clipboard text into a CRLF document leaves no stray literal newline", () => {
    const { handle, view } = mount();
    handle.applyDocument("ab\r\ncd", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(1) }); // mid "ab", not a list
    firePasteAt(view.contentDOM, { text: "x\ny" }); // no html/files: falls to CM's own doPaste
    expectLineModel(view.state.doc, ["ax", "yb", "cd"]);
    expectCleanLineModel(view.state.doc);
  });

  it("a multi-range selection maps every caret through a plain-text paste", () => {
    const { handle, view } = mount();
    handle.applyDocument("ab\r\ncd", true, 1);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(4)]),
    });
    firePasteAt(view.contentDOM, { text: "x\ny" });
    // ⚠️ Line COUNT cannot observe this one: with as many clipboard lines as
    // ranges, CodeMirror hands one line to each caret instead of splitting at
    // either, so the document keeps its two lines. Only the line TEXT shows
    // that both carets received their half.
    expectLineModel(view.state.doc, ["axb", "cyd"]);
    expectCleanLineModel(view.state.doc);
  });

  it("copyLineDown over a multi-line selection keeps a clean line model (commands:1416)", () => {
    const { handle, view } = mount();
    handle.applyDocument("one\r\ntwo", true, 1);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    expect(copyLineDown(view)).toBe(true);
    expectCleanLineModel(view.state.doc);
  });

  it("search replace with a \\n escape keeps a clean line model (search:565,929)", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb", true, 1);
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "a", replace: "X\\nY" })),
      selection: EditorSelection.single(0, 1), // exactly the "a" match, so replaceNext fires
    });
    expect(replaceNext(view)).toBe(true);
    expectCleanLineModel(view.state.doc);
  });

  it("Enter on a loose list item's continuation line does not throw", () => {
    // ⚠️ Caret placement is load-bearing: Quoll's continueListOnEnter OWNS Enter
    // on the marker line and defers only when the caret is elsewhere
    // (list-continuation-keymap.ts:100-103). Upstream's
    // insertNewlineContinueMarkup — the one that throws "Selection points
    // outside of document" in a CRLF document (lang-markdown:274-276) — is
    // reached only with the caret on a CONTINUATION/body line of a LOOSE item,
    // AND (measured empirically against the installed lang-markdown 6.5.0:
    // nonTightList's doubled `state.lineBreak` concatenation only overflows the
    // computed selection when nothing follows) at the END of the document. A
    // continuation-line caret mid-document reaches the same doubling code path
    // but lands in-bounds, so it stays green — only the end-of-document
    // instance throws. With the caret on the marker line this test would be
    // green and prove nothing.
    const { handle, view } = mount();
    // Two loose items ("a" / "b"), the SECOND carrying its own continuation
    // ("cont2") so the caret sits on that last item's body line, at doc end.
    handle.applyDocument("- a\r\n\r\n- b\r\n\r\n  cont2", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(continueListOnEnter(view)).toBe(false); // deferred: not the marker line
    expect(() => insertNewlineContinueMarkup(view)).not.toThrow();
    expectCleanLineModel(view.state.doc);
  });

  it("a CRLF-carrying string pasted into an LF document leaves no stray \\r", () => {
    // The LF-side twin: today's facet for an LF document is "\n", so a literal
    // "\r\n" split never happens and the \r stays inside the line text.
    const { handle, view } = mount();
    handle.applyDocument("ab\ncd", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(1) });
    firePasteAt(view.contentDOM, { text: "x\r\ny" });
    expectLineModel(view.state.doc, ["ax", "yb", "cd"]);
    expectCleanLineModel(view.state.doc);
  });
});

describe("boundary cases", () => {
  it("an emoji straddling the insert point keeps both halves of the surrogate pair", () => {
    const { handle, view } = mount();
    handle.applyDocument("- \u{1F600} first\r\n- second", true, 1);
    const line1 = view.state.doc.line(1);
    expect(line1.text).toBe("- \u{1F600} first");
    view.dispatch({ selection: EditorSelection.cursor(line1.to) }); // right after the emoji's word
    expect(continueListOnEnter(view)).toBe(true);
    // Whatever the resulting line model, the emoji's surrogate pair must survive
    // intact — no lone high/low surrogate half anywhere in the document.
    const full = view.state.doc.toString();
    expect(full).toContain("\u{1F600}");
    expect(full.replace(/\u{1F600}/gu, "")).not.toMatch(/[\uD800-\uDFFF]/);
    expectCleanLineModel(view.state.doc);
  });

  it("undo restores the exact pre-insert line model", () => {
    const { handle, view } = mount();
    handle.applyDocument("- first\r\n- second", true, 1);
    const before = ["- first", "- second"];
    expectLineModel(view.state.doc, before);
    view.dispatch({ selection: EditorSelection.cursor(7) });
    expect(continueListOnEnter(view)).toBe(true);
    expect(undo(view)).toBe(true);
    expectLineModel(view.state.doc, before);
  });
});

// The three pins that hold the arrangement in place. The first names the single
// CAUSE the suite above exists for; the second and third observe the OUTBOUND
// path, which no other test in the repo reaches
// (test/extension/e2e/crlf-roundtrip.test.ts injects a hand-built `edit` message
// and never runs the webview serializer).
describe("editor — the document EOL lives in state, not in CodeMirror's splitter", () => {
  it("the mounted editor never installs a literal-EOL splitter (the root cause)", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb", true, 1);
    // Auxiliary to expectCleanLineModel: this names the ONE cause the suite
    // above exists for. It is deliberately not the primary guard — a hand-built
    // `Text.of(["x\ny"])` or a `ChangeSet.of(spec, len, "\r\n")` corrupts a
    // facet-less state while this assertion stays green.
    expect(view.state.facet(EditorState.lineSeparator)).toBeUndefined();
    expect(view.state.lineBreak).toBe("\n");
    // ...while the document's own EOL is still known, and lives in the state so
    // that it is installed by the same commit as the document.
    expect(view.state.facet(quollDocumentEol)).toBe("\r\n");
  });

  it("copy carries the document's EOL", () => {
    // Asserted, not inherited: this fell out of the lineSeparator facet before
    // and now rests on one explicit clipboardOutputFilter. (copyViaEvent focuses
    // the view itself — CM's copy handler bails on hasSelection() in an
    // unfocused happy-dom view.)
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb", true, 1);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    expect(copyViaEvent(view)).toBe("a\r\nb");
    handle.applyDocument("a\nb", true, 2);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    expect(copyViaEvent(view)).toBe("a\nb");
  });

  it("a CRLF document's Edit reaches the wire as CRLF", () => {
    // ⚠️ A reseed posts NOTHING (editor.test.ts (r4) pins editPosts() empty), so
    // the EOL cannot be observed straight after applyDocument. Observe it
    // through a LOCAL edit plus the debounce (DEBOUNCE_MS = 300,
    // edit-sync.ts:37).
    //
    // What produces those bytes is `getDoc()` —
    // `serializeDocument(doc, state.facet(quollDocumentEol))` (editor.ts) — NOT
    // the CM document's own rendering. `sliceDoc()` returns LF for every
    // document now that `EditorState.lineSeparator` is never provided, so this
    // assertion cannot be written against it; the wire is the only place the
    // document's EOL reappears.
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb", true, 1);
    expect(editPosts()).toHaveLength(0);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "c" } });
    vi.advanceTimersByTime(300);
    expect((editPosts()[0] as { content: string }).content).toBe("a\r\nbc");
  });
});

/** Dispatch a real `copy` event with a stub `clipboardData` and return what
 *  CodeMirror wrote, so the assertion covers `copiedRange` + the output filter
 *  together rather than the filter alone.
 *
 *  focus() belongs INSIDE the helper, not at each call site: CM's copy handler
 *  bails on `hasSelection(view.contentDOM, view.observer.selectionRange)`
 *  (view/dist:5150), which is false in an unfocused happy-dom view — it writes
 *  nothing and the assertion then fails for a reason unrelated to the EOL. */
function copyViaEvent(view: EditorView): string {
  view.focus();
  let written = "";
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      // clearData is NOT optional: CM's copy handler calls it before setData
      // (view/dist:5164), so a stub without it throws instead of writing.
      clearData: () => {},
      setData: (_type: string, data: string) => {
        written = data;
      },
    },
  });
  view.contentDOM.dispatchEvent(event);
  return written;
}
