import { describe, expect, it } from "vitest";
import { EndOfLine, type TextDocument } from "vscode";

import {
  buildDocumentMessageFromDocument,
  canonicalDocumentText,
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
    });
    expect(msg.content).toBe("a\r\nb\r\nc");
    expect(msg.docVersion).toBe(3);
    expect(msg.externalEpoch).toBe(2);
    expect(msg.epochGeneration).toBe(99);
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "epochGeneration",
      "externalEpoch",
      "protocol",
      "themeKind",
      "type",
    ]);
  });
});

describe("decideEdit + canonicalDocumentText wiring", () => {
  const base = { baseDocVersion: 1, lastAppliedDocVersion: 1, canWrite: true };

  it("returns no-op when the inbound (canonical) content matches the canonicalized document (pins the EOL-adapter wiring)", () => {
    // getText() is MIXED; the webview echoes the CANONICAL form. Comparing
    // against canonicalDocumentText (not raw getText) yields no-op. Reverting
    // canonicalDocumentText to raw getText() makes this `accept` → test fails.
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
      markdownValidator: () => ({ ok: true }),
    });
    expect(verdict.kind).toBe("accept");
  });
});
