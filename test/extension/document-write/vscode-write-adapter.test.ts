import { afterEach, describe, expect, it, vi } from "vitest";
import { EndOfLine, Position, Range, type TextDocument, WorkspaceEdit, workspace } from "vscode";
import { createDocumentWriteAdapter } from "../../../src/extension/document-write/vscode-write-adapter.js";

function fakeDocument() {
  return {
    uri: { toString: () => "file:///doc.md" },
    text: "first\r\nsecond",
    version: 1,
    eol: EndOfLine.LF,
    getText() {
      return this.text;
    },
    positionAt(offset: number) {
      return new Position(0, offset);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createDocumentWriteAdapter", () => {
  it("reads live document text, version, and EOL", () => {
    const doc = fakeDocument();
    const adapter = createDocumentWriteAdapter(doc as unknown as TextDocument);
    expect(adapter.readText()).toBe("first\r\nsecond");
    expect(adapter.readVersion()).toBe(1);
    expect(adapter.readCanonical()).toBe("first\nsecond");
    expect(adapter.canonicalize("a\rb")).toBe("a\nb");

    doc.text = "next\nline";
    doc.version = 2;
    doc.eol = EndOfLine.CRLF;
    expect(adapter.readText()).toBe("next\nline");
    expect(adapter.readVersion()).toBe(2);
    expect(adapter.readCanonical()).toBe("next\r\nline");
    expect(adapter.canonicalize("a\rb")).toBe("a\r\nb");
  });

  it("builds one replacement with the span's range and inserted text", () => {
    const doc = fakeDocument();
    const replace = vi.spyOn(WorkspaceEdit.prototype, "replace");
    const adapter = createDocumentWriteAdapter(doc as unknown as TextDocument);
    const edit = adapter.build({ from: 1, to: 4, insert: "new" });

    expect(edit).toBeInstanceOf(WorkspaceEdit);
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      doc.uri,
      new Range(new Position(0, 1), new Position(0, 4)),
      "new"
    );
  });

  it("applies through the workspace by default", async () => {
    const apply = vi.spyOn(workspace, "applyEdit").mockResolvedValue(true);
    const adapter = createDocumentWriteAdapter(fakeDocument() as unknown as TextDocument);
    const edit = new WorkspaceEdit();

    await expect(Promise.resolve(adapter.apply(edit))).resolves.toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith(edit);
  });

  it("applies through the injected function when provided", async () => {
    const apply = vi.fn(async () => false);
    const workspaceApply = vi.spyOn(workspace, "applyEdit");
    const adapter = createDocumentWriteAdapter(fakeDocument() as unknown as TextDocument, apply);
    const edit = new WorkspaceEdit();

    await expect(Promise.resolve(adapter.apply(edit))).resolves.toBe(false);
    expect(apply).toHaveBeenCalledExactlyOnceWith(edit);
    expect(workspaceApply).not.toHaveBeenCalled();
  });
});
