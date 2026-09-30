import { describe, expect, it } from "vitest";
import { EndOfLine, type TextDocument } from "vscode";

import {
  buildDocumentMessageFromDocument,
  buildRejectedDraftFromDocument,
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
    });
    expect(msg.content).toBe("a\r\nb\r\nc");
    expect(msg.eol).toBe("\r\n");
    expect(msg.docVersion).toBe(3);
    expect(msg.externalEpoch).toBe(2);
    expect(msg.epochGeneration).toBe(99);
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "eol",
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

describe("documentEolOf / buildDocumentMessageFromDocument eol", () => {
  const metadata = {
    docVersion: 1,
    themeKind: "light" as const,
    canWrite: true,
    externalEpoch: 0,
    epochGeneration: 1,
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

describe("buildRejectedDraftFromDocument", () => {
  const metadata = {
    docVersion: 4,
    themeKind: "dark" as const,
    canWrite: false,
    externalEpoch: 3,
    epochGeneration: 7,
  };

  it("stamps a CRLF document's eol, including a draft with no line break", () => {
    const doc = fakeDoc(EndOfLine.CRLF, "unused");
    expect(buildRejectedDraftFromDocument(doc, "a", metadata).eol).toBe("\r\n");
    expect(buildRejectedDraftFromDocument(doc, "a\r\nb", metadata).eol).toBe("\r\n");
  });

  it("stamps an LF document's eol", () => {
    expect(
      buildRejectedDraftFromDocument(fakeDoc(EndOfLine.LF, "unused"), "a\nb", metadata).eol
    ).toBe("\n");
  });

  it("keeps the draft's raw bytes — neither canonicalised nor read from the document", () => {
    // An LF-joined draft against a CRLF document: the content must survive the
    // rejection untouched, and must not be replaced by document.getText().
    const msg = buildRejectedDraftFromDocument(
      fakeDoc(EndOfLine.CRLF, "x\r\ny"),
      "a\nb\nc",
      metadata
    );
    expect(msg.content).toBe("a\nb\nc");
    expect(msg.docVersion).toBe(4);
    expect(msg.themeKind).toBe("dark");
    expect(msg.canWrite).toBe(false);
    expect(msg.externalEpoch).toBe(3);
    expect(msg.epochGeneration).toBe(7);
    expect(Object.keys(msg).sort()).toEqual(
      Object.keys(buildDocumentMessageFromDocument(fakeDoc(EndOfLine.CRLF, "a"), metadata)).sort()
    );
  });
});
