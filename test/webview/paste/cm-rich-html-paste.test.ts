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

function firePaste(view: EditorView, data: { html?: string; text?: string }): Event {
  const store = new Map<string, string>();
  if (data.html !== undefined) {
    store.set("text/html", data.html);
  }
  if (data.text !== undefined) {
    store.set("text/plain", data.text);
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
  it("blank-line separates a fragment pasted mid-content", () => {
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<p>mid</p>", text: "mid" });
    expect(view.state.doc.toString()).toBe("hello\n\nmid\n\nworld");
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
    const event = firePaste(view, { html: "<p>hi</p>", text: "hi" });
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
});
