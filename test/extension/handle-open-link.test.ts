import { describe, expect, it } from "vitest";
import { Uri } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts (joinPath only)
import { type HandleOpenLinkDeps, handleOpenLink } from "../../src/extension/handle-open-link.js";

const makeUri = (path: string) => ({ path }) as unknown as import("vscode").Uri;

// documentUri = /ws/notes/doc.md ; workspace root = /ws
function makeDeps(overrides: Partial<HandleOpenLinkDeps> = {}) {
  const opened: string[] = [];
  const errors: string[] = [];
  const deps: HandleOpenLinkDeps = {
    documentUri: makeUri("/ws/notes/doc.md"),
    joinPath: (base, ...segments) => Uri.joinPath(base, ...segments),
    isInWorkspace: (uri) => uri.path.startsWith("/ws/"),
    openWith: (uri) => {
      opened.push(uri.path);
      return Promise.resolve(undefined);
    },
    showError: (m) => {
      errors.push(m);
    },
    ...overrides,
  };
  return { deps, opened, errors };
}

describe("handleOpenLink", () => {
  it("opens a same-directory .md link", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.md", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
  });

  it("opens a parent-relative .md link that stays in the workspace", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("../sibling/other.md", deps);
    expect(opened).toEqual(["/ws/sibling/other.md"]);
  });

  it("strips a #fragment before resolving", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.md#section", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
  });

  it("rejects a link that escapes the workspace", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("../../etc/passwd.md", deps); // -> /etc/passwd.md, not under /ws/
    expect(opened).toEqual([]);
  });

  it("falls back to the document directory when there is no workspace (single-file open)", () => {
    const { deps, opened } = makeDeps({ isInWorkspace: () => false });
    handleOpenLink("./other.md", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
  });

  it("rejects a parent escape when there is no workspace", () => {
    const { deps, opened } = makeDeps({ isInWorkspace: () => false });
    handleOpenLink("../other.md", deps);
    expect(opened).toEqual([]);
  });

  it("rejects a non-.md target", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.txt", deps);
    expect(opened).toEqual([]);
  });

  it("rejects an absolute path", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("/etc/passwd.md", deps);
    expect(opened).toEqual([]);
  });

  it("rejects a backslash path", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("..\\..\\escape.md", deps);
    expect(opened).toEqual([]);
  });

  it("rejects a scheme-bearing href", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("http://evil.example/x.md", deps);
    expect(opened).toEqual([]);
  });

  it("rejects a protocol-relative href", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("//evil.example/x.md", deps);
    expect(opened).toEqual([]);
  });

  it("rejects a pure fragment", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("#section", deps);
    expect(opened).toEqual([]);
  });

  it("rejects an href carrying a control byte", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.md", deps);
    expect(opened).toEqual([]);
  });

  it("shows an error toast when openWith rejects", async () => {
    const { deps, errors } = makeDeps({ openWith: () => Promise.reject(new Error("boom")) });
    handleOpenLink("./other.md", deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBe(1);
  });
});
