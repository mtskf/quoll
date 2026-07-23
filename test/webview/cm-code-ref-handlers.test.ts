import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { tryOpenCodeRefAt } from "../../src/webview/cm/code-ref/code-ref-handlers.js";

function stateFor(doc: string, sel?: number) {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: sel === undefined ? undefined : { anchor: sel },
  });
}

describe("tryOpenCodeRefAt", () => {
  it("posts open-code-reference for a path inside inline code", () => {
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
  });
  it("does not post for a non-path or .md inline code span", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("call `useState` now"), 8, host as never)).toBe(false);
    expect(tryOpenCodeRefAt(stateFor("see `a/b.md` x"), 6, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
  });
  it("does not post for inline code inside a link (link owns the click)", () => {
    const doc = "[`src/foo.ts`](other.md)";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(false);
  });
  it("does not post while the selection intersects the span (editing)", () => {
    const doc = "see `src/foo.ts` end";
    const host = { postMessage: vi.fn() };
    expect(
      tryOpenCodeRefAt(stateFor(doc, doc.indexOf("foo")), doc.indexOf("foo"), host as never)
    ).toBe(false);
  });
  it("does not post outside any inline code", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("plain src/foo.ts text"), 2, host as never)).toBe(false);
  });
});
