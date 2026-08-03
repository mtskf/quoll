// @vitest-environment happy-dom
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { richHtmlPaste } from "../../../src/webview/cm/paste/rich-html-paste.js";

function mount(doc: string, canWrite = true) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [EditorState.readOnly.of(!canWrite), richHtmlPaste({ canWrite: () => canWrite })],
    }),
  });
}

// The in-code guard needs a real Lezer tree to resolve the FencedCode node, so
// this variant loads the Markdown language. Kept separate from `mount` so the
// unrelated conversion tests stay language-free (matching the original file).
function mountMd(doc: string, canWrite = true) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown(),
        EditorState.readOnly.of(!canWrite),
        richHtmlPaste({ canWrite: () => canWrite }),
      ],
    }),
  });
}

function firePaste(
  view: EditorView,
  data: { html?: string; text?: string; uriList?: string }
): Event {
  const store = new Map<string, string>();
  if (data.html !== undefined) {
    store.set("text/html", data.html);
  }
  if (data.text !== undefined) {
    store.set("text/plain", data.text);
  }
  if (data.uriList !== undefined) {
    store.set("text/uri-list", data.uriList);
  }
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (t: string) => store.get(t) ?? "" },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("richHtmlPaste — handler", () => {
  it("converts a rich HTML fragment and consumes the event", () => {
    const view = mount("");
    const event = firePaste(view, {
      html: "<h1>Title</h1><p><strong>hi</strong></p>",
      text: "Title\nhi",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("# Title\n\n**hi**\n");
    view.destroy();
  });
  it("blank-line separates a converted fragment pasted mid-content", () => {
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<p><strong>mid</strong></p>", text: "mid" });
    expect(view.state.doc.toString()).toBe("hello\n\n**mid**\n\nworld");
    view.destroy();
  });
  it("composes prose + table on a mixed fragment", () => {
    const view = mount("");
    firePaste(view, {
      html: "<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>",
      text: "intro\nA\tB",
    });
    expect(view.state.doc.toString()).toBe("intro\n\n| A | B |\n| --- | --- |\n");
    view.destroy();
  });
  it("defers when there is no text/html flavour", () => {
    // The handler stays out (returns false, no html flavour); CM's own built-in
    // plain-text paste still runs and inserts the raw text/plain unconverted (it
    // owns preventDefault for that — a CM-core behaviour, not this handler's).
    const view = mount("x");
    firePaste(view, { text: "plain" });
    expect(view.state.doc.toString()).toBe("plainx");
    view.destroy();
  });
  it("defers an unconvertible (whitespace-only) HTML fragment", () => {
    // htmlToMarkdown → null (whitespace-only) → handler returns false; CM's own
    // built-in plain-text paste inserts the raw text/plain unconverted.
    const view = mount("x");
    firePaste(view, { html: "<p>   </p>", text: "   " });
    expect(view.state.doc.toString()).toBe("   x");
    view.destroy();
  });
  it("swallows a rich paste in a read-only editor without inserting", () => {
    const view = mount("", false);
    const event = firePaste(view, { html: "<p><strong>hi</strong></p>", text: "hi" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("defers to plain-text paste when the caret is inside a fenced code block", () => {
    // A <pre>-bearing fragment converts to a ``` fenced snippet whose delimiters
    // would prematurely close the surrounding fence. The guard must defer (return
    // false, NO preventDefault) so CM's core plain-text paste inserts the raw
    // text/plain verbatim and the outer fence stays intact. defaultPrevented is
    // an UNRELIABLE defer signal here (CM core runs and calls preventDefault
    // itself — repo convention, see cm-list-reindent-paste.test.ts), so the
    // contract is asserted on CONTENT: the raw text lands, no fence is injected.
    const view = mountMd("```\n\n```");
    view.dispatch({ selection: { anchor: 4 } }); // inside the fence (blank interior line)
    firePaste(view, { html: "<pre>code</pre>", text: "code" });
    // Plain "code" lands verbatim; no extra ``` fence lines from the conversion.
    expect(view.state.doc.toString()).toBe("```\ncode\n```");
    view.destroy();
  });

  it("still converts a rich fragment when the caret is outside any code block", () => {
    // Same markdown-aware mount, but the caret sits in prose: rich conversion is
    // unchanged (guard is a no-op outside code).
    const view = mountMd("intro\n\n");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const event = firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\n\n# Title\n");
    view.destroy();
  });

  it("defers to plain-text paste when the caret is inside an indented code block", () => {
    // caretInCode covers CodeBlock (4-space indented), not just FencedCode. A
    // converted fragment's blockPrefix/blockSuffix blank lines (or the inserted
    // non-indented text itself) would terminate the indented block early.
    const view = mountMd("para\n\n    foo\n");
    view.dispatch({ selection: { anchor: 11 } }); // inside "foo", after the "f"
    firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(view.state.doc.toString()).toBe("para\n\n    fTitleoo\n");
    view.destroy();
  });

  it("defers when the caret sits on the fence-opener line itself (left-bias boundary)", () => {
    // caretInCode resolves with -1 bias, so a caret immediately after the
    // opening ``` (still on that line) resolves into the FencedCode node.
    const view = mountMd("```\n\n```");
    view.dispatch({ selection: { anchor: 3 } }); // right after the opening ```
    firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(view.state.doc.toString()).toBe("```Title\n\n```");
    view.destroy();
  });

  it("still converts a rich fragment when the caret is inside an inline code span (out of guard scope)", () => {
    // caretInCode only walks FencedCode / CodeBlock ancestry — inline code spans
    // are a different Lezer node and are NOT covered. This pins the current
    // scope: if caretInCode is ever widened to include inline code, this test
    // will visibly change (doc would stop showing a converted fragment here).
    const view = mountMd("para `foo` more");
    view.dispatch({ selection: { anchor: 7 } }); // inside `foo`, after the "f"
    const event = firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("para `f\n\n# Title\n\noo` more");
    view.destroy();
  });

  it("defers a selection that starts in prose and extends into a fenced code block", () => {
    // A non-empty selection whose `from` sits in plain prose but whose `to`
    // crosses into code must still defer — checking `from` alone would miss it
    // and let a <pre>-bearing fragment inject a stray ``` inside the fence.
    const view = mountMd("before\n\n```\n\n```");
    view.dispatch({ selection: { anchor: 3, head: 11 } }); // "bef|ore\n\n```|\n\n```"
    firePaste(view, { html: "<pre>x</pre>", text: "XX" });
    // Selection is replaced by the plain-text fallback; no extra ``` from the
    // <pre> conversion, and the untouched closing fence survives intact.
    expect(view.state.doc.toString()).toBe("befXX\n\n```");
    view.destroy();
  });

  it("consumes an HTML-only paste touching code without deleting the selection", () => {
    // With no text/plain or text/uri-list fallback, deferring (return false)
    // would let CM's core paste run doPaste(view, "") — which replaces the
    // selection with nothing, deleting the selected code. The guard must
    // instead consume the event itself (preventDefault + return true) and
    // leave the document untouched.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    const event = firePaste(view, { html: "<h1>Title</h1>" }); // no text key at all
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```");
    view.destroy();
  });

  it("defers to CM's uri-list fallback for an in-code paste with no text/plain", () => {
    // hasPlainFallback is also true for text/uri-list (mirrors CM core's own
    // getData("text/plain") || getData("text/uri-list")). With no text/plain but a
    // uri-list present, the guard defers and CM core inserts the uri-list value.
    // Dropping the uri-list clause would fall through to consume, leaving the
    // selection untouched instead of replaced — making this assertion non-vacuous.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    firePaste(view, { html: "<h1>Title</h1>", uriList: "https://example.com" });
    expect(view.state.doc.toString()).toBe("```\nhttps://example.com\n```");
    view.destroy();
  });

  it("consumes an HTML-only unconvertible paste in code without deleting the selection", () => {
    // Whitespace-only HTML → htmlToMarkdown returns null. The guard now runs BEFORE
    // that check, so an HTML-only clipboard (no text/plain) over a code selection is
    // consumed (preventDefault, no dispatch) instead of falling through to the
    // md===null defer, which would let CM's core doPaste("") delete the selection.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    const event = firePaste(view, { html: "<p>   </p>" }); // whitespace-only, no text
    expect(event.defaultPrevented).toBe(true); // we consume it (not a defer) → reliable
    expect(view.state.doc.toString()).toBe("```\nfoo\n```"); // selection untouched
    view.destroy();
  });
});

describe("richHtmlPaste — plain-text-like fragments defer", () => {
  // The reported bug: a plain Markdown checklist copied out of a text editor
  // arrives with a presentational `text/html` flavour. Converting it escaped the
  // user's own markers and merged the blank-line-separated items.
  const CHECKLIST_HTML =
    '<div style="color:#ccc"><div><span>- [ ] first</span></div><br>' +
    "<div><span>- [ ] second</span></div></div>";
  const CHECKLIST_PLAIN = "- [ ] first\n\n- [ ] second";

  it("inserts the clipboard's plain text verbatim, unescaped and unmerged", () => {
    const view = mount("");
    firePaste(view, { html: CHECKLIST_HTML, text: CHECKLIST_PLAIN });
    expect(view.state.doc.toString()).toBe(CHECKLIST_PLAIN);
    view.destroy();
  });

  it("still converts when the fragment carries real Markdown syntax", () => {
    const view = mount("");
    const event = firePaste(view, {
      html: "<p>Hello <strong>bold</strong> - [ ] not a task</p>",
      text: "Hello bold - [ ] not a task",
    });
    expect(event.defaultPrevented).toBe(true);
    // The deliberate escaping is intact: the stray task marker stays literal.
    expect(view.state.doc.toString()).toBe("Hello **bold** - \\[ \\] not a task\n");
    view.destroy();
  });

  it("converts a syntax-free fragment when there is no text/plain to fall back to", () => {
    const view = mount("");
    const event = firePaste(view, { html: "<p>only html</p>" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("only html\n");
    view.destroy();
  });

  it("pastes text that merely LOOKS like Markdown as Markdown (accepted trade-off)", () => {
    // Deliberate, and the sharpest edge of this design — see "The objection" in
    // the plan. A `<p>` holding literal `# Release notes` is not rich content, so
    // the user's own bytes go in verbatim and the heading activates, exactly as it
    // already does when the source app attaches no `text/html` flavour at all.
    // Change this expectation only with a matching decision record.
    const view = mount("");
    firePaste(view, { html: "<p># Release notes</p>", text: "# Release notes" });
    expect(view.state.doc.toString()).toBe("# Release notes");
    view.destroy();
  });

  it("stays inert in a read-only editor on the defer path too", () => {
    // The defer returns BEFORE the handler's own canWrite() check, so read-only
    // safety on this path is inherited from CM's builtin paste handler, which
    // early-returns on view.state.readOnly. That is only sound because
    // EditorState.readOnly / EditorView.editable (the `editableComp` compartment
    // in editor.ts) are reconfigured from the SAME `canWrite` wire value that
    // feeds opts.canWrite() — see the identical note in html-table-paste.ts.
    // Pin it, so decoupling the two shows up as a red test rather than a
    // read-only document silently accepting a paste.
    const view = mount("", false);
    firePaste(view, { html: CHECKLIST_HTML, text: CHECKLIST_PLAIN });
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("inserts a plain-text-shaped fragment inline at the caret, without block framing", () => {
    // Deliberate behaviour change (see "Behaviour change" below): block framing
    // is for CONVERTED rich content. A clipboard that is really just the word
    // "mid" must land where the caret is, exactly as a no-`text/html` paste does.
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<p>mid</p>", text: "mid" });
    expect(view.state.doc.toString()).toBe("hellomidworld");
    view.destroy();
  });
});
