import { describe, expect, it } from "vitest";
import { resolveCodeReferenceCandidates } from "../../src/extension/links/resolve-code-reference.js";

function uri(path: string) {
  return { scheme: "file", authority: "", path } as never;
}
const joinPath = (base: { path: string }, ...segs: string[]) => {
  const parts = base.path.split("/").filter(Boolean);
  for (const seg of segs.flatMap((s) => s.split("/"))) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return uri(`/${parts.join("/")}`);
};
const deps = (over = {}) => ({
  documentUri: uri("/ws/docs/notes.md"),
  workspaceFolderUris: [uri("/ws")],
  joinPath,
  ...over,
});

describe("resolveCodeReferenceCandidates", () => {
  it("resolves against the workspace root (not the doc dir)", () => {
    expect(
      resolveCodeReferenceCandidates("src/foo.ts", deps() as never).map((c) => c.target.path)
    ).toEqual(["/ws/src/foo.ts"]);
  });
  it("returns one candidate per workspace folder", () => {
    expect(
      resolveCodeReferenceCandidates(
        "src/foo.ts",
        deps({ workspaceFolderUris: [uri("/ws"), uri("/ws2")] }) as never
      ).map((c) => c.target.path)
    ).toEqual(["/ws/src/foo.ts", "/ws2/src/foo.ts"]);
  });
  it("falls back to the doc dir when no workspace is open", () => {
    expect(
      resolveCodeReferenceCandidates("src/foo.ts", deps({ workspaceFolderUris: [] }) as never).map(
        (c) => c.target.path
      )
    ).toEqual(["/ws/docs/src/foo.ts"]);
  });
  it("drops a traversal that escapes every base", () => {
    expect(resolveCodeReferenceCandidates("../../etc/passwd", deps() as never)).toEqual([]);
  });
  it("rejects scheme / absolute / backslash / .md", () => {
    expect(resolveCodeReferenceCandidates("http://x/y", deps() as never)).toEqual([]);
    expect(resolveCodeReferenceCandidates("/etc/passwd", deps() as never)).toEqual([]);
    expect(resolveCodeReferenceCandidates("a\\b", deps() as never)).toEqual([]);
    expect(resolveCodeReferenceCandidates("Other.MD", deps() as never)).toEqual([]);
  });
  it("rejects protocol-relative, control bytes, empty (isAllowedUrl)", () => {
    expect(resolveCodeReferenceCandidates("//evil/x", deps() as never)).toEqual([]);
    expect(resolveCodeReferenceCandidates("a/\u0001b", deps() as never)).toEqual([]);
    expect(resolveCodeReferenceCandidates("", deps() as never)).toEqual([]);
  });
});
