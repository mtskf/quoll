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
import {
  type DocumentEol,
  quollDocumentEol,
  serializeDocument,
} from "../../../src/webview/cm/seed.js";

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
  it("outboundContentLength's second parameter is DocumentEol, not string (compile-time pin)", () => {
    // `view.state.lineBreak` is typed `string`, not `DocumentEol` — passing it
    // silently under-counted a CRLF document's outbound length (PR #414).
    // This pins the narrowed parameter type so a future widening back to `string`
    // is a compile error, not just a runtime under-count.
    const wrong: string = "\n";
    // @ts-expect-error outboundContentLength's second parameter is DocumentEol, not string
    outboundContentLength("x", wrong);
    // Correct usage still type-checks (DocumentEol-typed value and literals) — expect
    // the return value so a too-narrow parameter type would also fail here at runtime.
    const right: DocumentEol = "\r\n";
    expect(outboundContentLength("a\nb", right)).toBe(4);
    expect(outboundContentLength("a\nb", "\n")).toBe(3);
  });
  it("keeps a real line model on a CRLF doc's multi-line insert", () => {
    // Realistic CRLF doc. CodeMirror splits a string insert with its own default
    // /\r\n?|\n/ (EditorState.lineSeparator is never provided), so the formatter's
    // LF-joined multi-line table insert splits correctly and the table keeps its
    // rows. (doc.toString() is LF-internal, so the formatter's positions align.)
    const view = new EditorView({
      state: EditorState.create({
        doc: "| a | bbbb |\r\n| - | - |\r\n| 1 | 2 |\r\n",
        // Quoll's own EOL facet — EditorState.lineSeparator is deliberately never
        // provided in production (cm/seed.ts), so a fixture that set it would stop
        // representing the real editor while still passing.
        extensions: [quollDocumentEol.of("\r\n")],
      }),
    });
    expect(runFormatDocument(view)).toBe(true);
    // Header + delimiter + body + trailing empty line = 4 CM lines (NOT collapsed
    // into 1 by a stray embedded LF).
    expect(view.state.doc.lines).toBe(4);
    const serialized = serializeDocument(view.state.doc, view.state.facet(quollDocumentEol));
    // Every newline is a real \r\n — no stray bare LF embedded inside a line.
    expect(serialized.replace(/\r\n/g, "")).not.toContain("\n");
    expect(view.state.doc.line(1).text).toBe("| a   | bbbb |");
    expect(view.state.doc.line(2).text).toBe("| --- | ---- |");
    expect(view.state.doc.line(3).text).toBe("| 1   | 2    |");
    view.destroy();
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

describe("runFormatDocument — the outbound size cap is measured in the document's EOL", () => {
  it("bails when the result fits the cap as LF but exceeds it as CRLF", () => {
    // The guard this pins: format-document-command.ts's size check (the
    // `outboundContentLength(...) > MAX_CONTENT_LENGTH` bail) must read Quoll's
    // EOL facet, not `view.state.lineBreak`. Since EditorState.lineSeparator is
    // never provided, state.lineBreak is ALWAYS "\n", so reading it under-counts
    // a CRLF document by one byte per line — an oversized result would mutate the
    // document and only then fail to post (editor.ts's postEditMessage cap
    // check), leaving it formatted but unsaved.
    //
    // The insert sits exactly AT the cap under LF and over it under CRLF:
    //   length        = 2 * (MAX/2)           = MAX          (not > MAX: proceeds)
    //   CRLF-serialized = MAX + MAX/2                        (> MAX: bails)
    // ⚠️ It must REPLACE the whole document, not insert at {0,0}: inserting would
    // keep the fixture's own text and push BOTH counts over the cap, so the test
    // would bail either way and prove nothing.
    const big = "x\n".repeat(MAX_CONTENT_LENGTH / 2);
    expect(outboundContentLength(big, "\n")).toBe(MAX_CONTENT_LENGTH);
    expect(outboundContentLength(big, "\r\n")).toBeGreaterThan(MAX_CONTENT_LENGTH);
    const view = new EditorView({
      state: EditorState.create({ doc: "a", extensions: [quollDocumentEol.of("\r\n")] }),
    });
    const spy = vi
      .spyOn(fmtIndex, "formatDocumentEdits")
      .mockReturnValue([{ from: 0, to: view.state.doc.length, insert: big }]);
    expect(runFormatDocument(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("a");
    spy.mockRestore();
    view.destroy();
  });
});
