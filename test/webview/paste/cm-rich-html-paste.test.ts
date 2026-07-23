// @vitest-environment happy-dom
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
});
