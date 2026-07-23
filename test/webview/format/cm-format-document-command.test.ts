// @vitest-environment happy-dom
// (new EditorView requires a DOM — every test/webview/* file carries this pragma)
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import * as fmtIndex from "../../../src/markdown/format/index.js";
import { MAX_CONTENT_LENGTH } from "../../../src/shared/protocol.js";
import {
  outboundContentLength,
  runFormatDocument,
} from "../../../src/webview/cm/format/format-document-command.js";

function makeView(doc: string, readOnly = false): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: readOnly ? [EditorState.readOnly.of(true)] : [] }),
  });
}
function countDispatch(view: EditorView): () => number {
  let n = 0;
  const orig = view.dispatch.bind(view);
  view.dispatch = ((...a: Parameters<typeof orig>) => {
    n++;
    return orig(...a);
  }) as typeof view.dispatch;
  return () => n;
}

describe("runFormatDocument", () => {
  it("dispatches ONE transaction when formatting changes bytes", () => {
    const view = makeView("1. a\n1. b\n\n\n\nc  \n");
    const dispatched = countDispatch(view);
    expect(runFormatDocument(view)).toBe(true);
    expect(dispatched()).toBe(1);
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n\nc  \n");
    view.destroy();
  });
  it("is a no-op (no dispatch) when already formatted", () => {
    const view = makeView("1. a\n2. b\n");
    const dispatched = countDispatch(view);
    expect(runFormatDocument(view)).toBe(false);
    expect(dispatched()).toBe(0);
    view.destroy();
  });
  it("does nothing when read-only (would otherwise renumber)", () => {
    const view = makeView("1. a\n1. b\n", true);
    expect(runFormatDocument(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("1. a\n1. b\n");
    view.destroy();
  });
  it("catches a formatter throw: no crash, no mutation, returns false", () => {
    const spy = vi.spyOn(fmtIndex, "formatDocumentEdits").mockImplementation(() => {
      throw new Error("boom");
    });
    const view = makeView("1. a\n");
    expect(() => runFormatDocument(view)).not.toThrow();
    expect(runFormatDocument(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("1. a\n");
    spy.mockRestore();
    view.destroy();
  });
  it("bails on OVERLAPPING edits (applyEdits guard connected to runtime path)", () => {
    const spy = vi.spyOn(fmtIndex, "formatDocumentEdits").mockReturnValue([
      { from: 0, to: 3, insert: "X" },
      { from: 2, to: 4, insert: "Y" },
    ]);
    const view = makeView("abcdef");
    expect(runFormatDocument(view)).toBe(false); // applyEdits throws -> caught
    expect(view.state.doc.toString()).toBe("abcdef"); // no silent corruption
    spy.mockRestore();
    view.destroy();
  });
  it("bails when the result exceeds MAX_CONTENT_LENGTH (no silent host drop)", () => {
    const big = "x".repeat(MAX_CONTENT_LENGTH + 1);
    const spy = vi
      .spyOn(fmtIndex, "formatDocumentEdits")
      .mockReturnValue([{ from: 0, to: 0, insert: big }]);
    const view = makeView("a");
    expect(runFormatDocument(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("a");
    spy.mockRestore();
    view.destroy();
  });
  it("outboundContentLength counts CRLF-serialized length (edit-sync posts CRLF)", () => {
    // CRLF doc: each `\n` serializes to `\r\n`, so the outbound length exceeds the
    // LF-internal length by one byte per newline.
    expect(outboundContentLength("a\nb\nc", "\r\n")).toBe(7);
    expect(outboundContentLength("a\nb", "\n")).toBe(3);
    expect(outboundContentLength("no newline", "\r\n")).toBe(10);
  });
  it("catches an out-of-range edit (dispatch RangeError) without crashing", () => {
    const spy = vi
      .spyOn(fmtIndex, "formatDocumentEdits")
      .mockReturnValue([{ from: 0, to: 9999, insert: "X" }]);
    const view = makeView("abc");
    expect(() => runFormatDocument(view)).not.toThrow();
    expect(runFormatDocument(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("abc");
    spy.mockRestore();
    view.destroy();
  });
});
