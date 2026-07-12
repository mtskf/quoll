// @vitest-environment happy-dom
//
// runFormatCommand's guards need a real EditorView (readOnly facet + a focus
// state), so these live in their own happy-dom file — separate from the pure
// compute-layer tests. They pin the two byte-mutating guards: the edit only
// applies when the editor content owns focus AND the document is writable.
//
// `hasFocus` is the guard's input; we set it directly with defineProperty rather
// than calling view.focus(), because a real focus() fires a selectionchange that
// happy-dom flushes through CodeMirror's DOMObserver mid-test (re-entrant
// dispatch). Stubbing the getter supplies the precondition deterministically.
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { runFormatCommand } from "../../../src/webview/cm/inline/inline-formatting-commands.js";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(
  doc: string,
  sel: { anchor: number; head?: number },
  opts: { readOnly?: boolean; focused?: boolean } = {}
): EditorView {
  const v = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(sel.anchor, sel.head ?? sel.anchor),
      extensions: [
        EditorState.readOnly.of(opts.readOnly ?? false),
        EditorView.editable.of(!(opts.readOnly ?? false)),
      ],
    }),
    parent: document.body,
  });
  Object.defineProperty(v, "hasFocus", { get: () => opts.focused ?? false, configurable: true });
  view = v;
  return v;
}

describe("runFormatCommand guards", () => {
  it("formats when the editor content is focused and writable", () => {
    const v = mount("foo", { anchor: 0, head: 3 }, { focused: true });
    expect(runFormatCommand(v, "bold")).toBe(true);
    expect(v.state.sliceDoc()).toBe("**foo**");
  });

  it("is a no-op when the editor content is NOT focused (hasFocus guard)", () => {
    // A chord forwarded while focus sits in another webview control (e.g. the
    // search panel) must not mutate the document.
    const v = mount("foo", { anchor: 0, head: 3 }, { focused: false });
    expect(runFormatCommand(v, "bold")).toBe(false);
    expect(v.state.sliceDoc()).toBe("foo");
  });

  it("is a no-op on a read-only document even when focused (readOnly guard)", () => {
    // Focused so we get past the hasFocus guard and actually exercise the
    // readOnly guard — a raw `changes` dispatch is NOT blocked by the readOnly
    // facet, so removing the guard would mutate here.
    const v = mount("foo", { anchor: 0, head: 3 }, { readOnly: true, focused: true });
    expect(runFormatCommand(v, "bold")).toBe(false);
    expect(v.state.sliceDoc()).toBe("foo");
  });
});
