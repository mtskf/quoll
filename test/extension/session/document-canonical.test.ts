import { describe, expect, it } from "vitest";
import { EndOfLine, type TextDocument } from "vscode";

import {
  buildDocumentMessageFromDocument,
  canonicalDocumentText,
  documentEolOf,
} from "../../../src/extension/session/document-canonical.js";
import { decideEdit } from "../../../src/extension/session/edit-decision.js";

function fakeDoc(eol: EndOfLine, text: string): Pick<TextDocument, "eol" | "getText"> {
  return { eol, getText: () => text } as Pick<TextDocument, "eol" | "getText">;
}

describe("canonicalDocumentText", () => {
  it("normalizes mixed CRLF+LF to the document's CRLF eol", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.CRLF, "a\r\nb\nc"))).toBe("a\r\nb\r\nc");
  });
  it("normalizes mixed CRLF+LF to the document's LF eol", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.LF, "a\r\nb\nc"))).toBe("a\nb\nc");
  });
  it("normalizes CR-only to the document's CRLF eol", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.CRLF, "a\rb\rc"))).toBe("a\r\nb\r\nc");
  });
  it("normalizes CR-only to the document's LF eol", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.LF, "a\rb\rc"))).toBe("a\nb\nc");
  });
  it("is a no-op for already-uniform CRLF (eol=CRLF) and LF (eol=LF)", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.CRLF, "a\r\nb\r\nc"))).toBe("a\r\nb\r\nc");
    expect(canonicalDocumentText(fakeDoc(EndOfLine.LF, "a\nb\nc"))).toBe("a\nb\nc");
  });
  it("preserves a trailing separator (no off-by-one drop)", () => {
    expect(canonicalDocumentText(fakeDoc(EndOfLine.CRLF, "a\nb\n"))).toBe("a\r\nb\r\n");
  });
});

describe("buildDocumentMessageFromDocument", () => {
  it("normalizes a mixed-EOL document's content to its eol (pins the wiring, not just the helper)", () => {
    const msg = buildDocumentMessageFromDocument(fakeDoc(EndOfLine.CRLF, "a\r\nb\nc"), {
      docVersion: 3,
      themeKind: "light",
      canWrite: true,
      externalEpoch: 2,
      epochGeneration: 99,
      settledEditId: 7,
    });
    expect(msg.content).toBe("a\r\nb\r\nc");
    expect(msg.eol).toBe("\r\n");
    expect(msg.docVersion).toBe(3);
    expect(msg.externalEpoch).toBe(2);
    expect(msg.epochGeneration).toBe(99);
    expect(msg.settledEditId).toBe(7);
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "eol",
      "epochGeneration",
      "externalEpoch",
      "protocol",
      "settledEditId",
      "themeKind",
      "type",
    ]);
  });
});

describe("decideEdit + canonicalDocumentText wiring", () => {
  const base = { baseIsCurrent: true, canWrite: true };

  it("returns no-op when the inbound content matches the canonicalized document (verdict only — the canonicalisation itself is pinned in test/extension/document-write)", () => {
    // getText() is MIXED; the webview echoes the CANONICAL form → no-op.
    // (Since decideEdit's no-op check became EOL-insensitive, a raw getText()
    // here would ALSO read as no-op — this pins the verdict, no longer the
    // canonicalisation; the canonical form still matters for the executor's
    // byte-level snapshots, pinned in test/extension/document-write.)
    const doc = fakeDoc(EndOfLine.CRLF, "a\r\nb\nc");
    const verdict = decideEdit({
      ...base,
      content: "a\r\nb\r\nc",
      currentContent: canonicalDocumentText(doc),
    });
    expect(verdict.kind).toBe("no-op");
  });

  it("returns accept for a genuine edit (content differs from the canonical document)", () => {
    const doc = fakeDoc(EndOfLine.CRLF, "a\r\nb\nc");
    const verdict = decideEdit({
      ...base,
      content: "a\r\nCHANGED\r\nc",
      currentContent: canonicalDocumentText(doc),
    });
    expect(verdict.kind).toBe("accept");
  });
});

describe("documentEolOf / buildDocumentMessageFromDocument eol", () => {
  const metadata = {
    docVersion: 1,
    themeKind: "light" as const,
    canWrite: true,
    externalEpoch: 0,
    epochGeneration: 1,
    settledEditId: 0,
  };

  it("maps EndOfLine to the wire separator", () => {
    expect(documentEolOf(EndOfLine.CRLF)).toBe("\r\n");
    expect(documentEolOf(EndOfLine.LF)).toBe("\n");
  });

  it("emits the document's eol even when the content has no line break", () => {
    // The case inference could never get right: a no-newline CRLF document
    // carries no evidence of its EOL in its bytes. The wire eol comes from
    // TextDocument.eol, not from the content.
    expect(buildDocumentMessageFromDocument(fakeDoc(EndOfLine.CRLF, "a"), metadata).eol).toBe(
      "\r\n"
    );
    expect(buildDocumentMessageFromDocument(fakeDoc(EndOfLine.LF, "a"), metadata).eol).toBe("\n");
  });
});
