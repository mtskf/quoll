// The document-EOL seam: the state-carried facet and the pure outbound
// serializer. These are the pieces editor.ts wires together so that the
// CodeMirror interior stays LF-only while the host still receives each
// document's own bytes. The EOL itself is NOT detected here — it arrives on the
// wire (`DocumentMessage.eol`); the "no inference" pin lives in the mounted
// suite test/webview/cm-crlf-line-model.test.ts.
//
// The load-bearing assertion here is the second one: `EditorState.lineSeparator`
// must stay UNPROVIDED. Providing it replaces CodeMirror's default insert
// splitter (/\r\n?|\n/) with a literal split, which is the whole defect this
// seam exists to avoid — see src/webview/cm/seed.ts's quollDocumentEol.
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollDocumentEol, serializeDocument, splitToCmText } from "../../src/webview/cm/seed.js";

describe("document EOL seam", () => {
  it("serializes with the EOL it is given, not with editor state", () => {
    const doc = splitToCmText("a\r\nb");
    expect(serializeDocument(doc, "\r\n")).toBe("a\r\nb");
    expect(serializeDocument(doc, "\n")).toBe("a\nb");
  });

  it("carries the EOL in the state without providing CodeMirror's splitter", () => {
    const state = EditorState.create({
      doc: splitToCmText("a\r\nb"),
      extensions: [quollDocumentEol.of("\r\n")],
    });
    expect(state.facet(quollDocumentEol)).toBe("\r\n");
    // The point of the whole design: CM's own splitter facet stays unset, so
    // ChangeSet.of and state.toText keep their default /\r\n?|\n/ and no
    // multi-line insert can survive as a literal \n inside one line.
    expect(state.facet(EditorState.lineSeparator)).toBeUndefined();
    expect(state.lineBreak).toBe("\n");
    // Interior is LF regardless of the document's on-disk ending.
    expect(state.doc.lines).toBe(2);
    expect(state.doc.line(1).text).toBe("a");
  });

  it("defaults to LF with no provider", () => {
    const state = EditorState.create({ doc: splitToCmText("a") });
    expect(state.facet(quollDocumentEol)).toBe("\n");
    expect(serializeDocument(state.doc, state.facet(quollDocumentEol))).toBe("a");
  });
});
