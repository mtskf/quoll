import { describe, expect, it } from "vitest";

import { canEditWith, type EditWithCandidate } from "../../src/extension/canEditWith.js";
import type { IsWritableFileSystem } from "../../src/extension/fileSystem.js";

const writable: IsWritableFileSystem = () => true;
const readonly: IsWritableFileSystem = () => false;
const unknownScheme: IsWritableFileSystem = () => undefined;

const mdFile: EditWithCandidate = {
  uri: { scheme: "file", path: "/Users/m/notes/foo.md" },
  languageId: "markdown",
};

describe("canEditWith", () => {
  it("accepts a writable markdown file:// document", () => {
    expect(canEditWith(mdFile, writable)).toEqual({ ok: true });
  });

  it("accepts a markdown file:// document when the FS scheme is unknown", () => {
    // `workspace.fs.isWritableFileSystem` may return `undefined` for the
    // `file:` scheme on some builds. canEditWith (like canHostWrite) treats
    // that as writable so local Markdown editing still works.
    expect(canEditWith(mdFile, unknownScheme)).toEqual({ ok: true });
  });

  it("accepts a .md filename even when languageId is plaintext", () => {
    expect(
      canEditWith(
        { uri: { scheme: "file", path: "/Users/m/notes/foo.md" }, languageId: "plaintext" },
        writable
      )
    ).toEqual({ ok: true });
  });

  it("rejects untitled documents", () => {
    const result = canEditWith(
      { uri: { scheme: "untitled", path: "Untitled-1" }, languageId: "markdown" },
      writable
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/untitled/);
    }
  });

  it.each([
    "git",
    "vscode-vfs",
    "output",
    "https",
    "vscode-userdata",
  ])("rejects non-file scheme %s", (scheme) => {
    const result = canEditWith(
      { uri: { scheme, path: "/foo.md" }, languageId: "markdown" },
      writable
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(scheme);
    }
  });

  it("rejects non-markdown documents (txt, plaintext)", () => {
    const result = canEditWith(
      { uri: { scheme: "file", path: "/Users/m/notes/foo.txt" }, languageId: "plaintext" },
      writable
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Markdown/);
    }
  });

  it("rejects .mdx files even when languageId is markdown", () => {
    const result = canEditWith(
      { uri: { scheme: "file", path: "/Users/m/notes/foo.mdx" }, languageId: "markdown" },
      writable
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/MDX/);
    }
  });

  it("rejects readonly file:// documents", () => {
    const result = canEditWith(mdFile, readonly);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/read-only/);
    }
  });

  it("does not consult the writable check until scheme/extension pass", () => {
    // A readonly FS callback that throws would surface if called for an
    // already-rejected document; the guard must short-circuit before then.
    const throwing: IsWritableFileSystem = () => {
      throw new Error("isWritableFileSystem should not be called for rejected documents");
    };
    expect(
      canEditWith({ uri: { scheme: "git", path: "/foo.md" }, languageId: "markdown" }, throwing).ok
    ).toBe(false);
    expect(
      canEditWith({ uri: { scheme: "file", path: "/foo.mdx" }, languageId: "markdown" }, throwing)
        .ok
    ).toBe(false);
    expect(
      canEditWith({ uri: { scheme: "file", path: "/foo.txt" }, languageId: "plaintext" }, throwing)
        .ok
    ).toBe(false);
  });
});
