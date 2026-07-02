import { describe, expect, it } from "vitest";
import { EndOfLine, type TextDocument } from "vscode";

import {
  buildDocumentMessageFromDocument,
  canonicalDocumentText,
  decideEditForDocument,
} from "../../src/extension/document-canonical.js";

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
      isDarkTheme: false,
      canWrite: true,
    });
    expect(msg.content).toBe("a\r\nb\r\nc");
    expect(msg.docVersion).toBe(3);
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "isDarkTheme",
      "protocol",
      "type",
    ]);
  });
});

describe("decideEditForDocument", () => {
  const base = { baseDocVersion: 1, lastAppliedDocVersion: 1, canWrite: true };

  it("returns no-op when the inbound (canonical) content matches the canonicalized document (pins the wiring)", () => {
    // getText() is MIXED; the webview echoes the CANONICAL form. Comparing
    // against canonicalDocumentText (not raw getText) yields no-op. Reverting
    // the adapter to raw getText() makes this `accept` → test fails.
    const verdict = decideEditForDocument(fakeDoc(EndOfLine.CRLF, "a\r\nb\nc"), {
      ...base,
      content: "a\r\nb\r\nc",
    });
    expect(verdict.kind).toBe("no-op");
  });

  it("returns accept for a genuine edit (content differs from the canonical document)", () => {
    const verdict = decideEditForDocument(fakeDoc(EndOfLine.CRLF, "a\r\nb\nc"), {
      ...base,
      content: "a\r\nCHANGED\r\nc",
      markdownValidator: () => ({ ok: true }),
    });
    expect(verdict.kind).toBe("accept");
  });
});
