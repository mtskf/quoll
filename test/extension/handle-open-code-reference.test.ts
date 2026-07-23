import { describe, expect, it, vi } from "vitest";
import { handleOpenCodeReference } from "../../src/extension/links/handle-open-code-reference.js";

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
function makeDeps(over: Record<string, unknown> = {}) {
  const revealInTextEditor = vi.fn().mockResolvedValue(undefined);
  const showError = vi.fn();
  const showNotFound = vi.fn();
  const deps = {
    documentUri: uri("/ws/docs/notes.md"),
    workspaceFolderUris: [uri("/ws")],
    joinPath,
    pathExists: vi.fn().mockResolvedValue(true),
    revealInTextEditor,
    showError,
    showNotFound,
    ...over,
  };
  return { deps, revealInTextEditor, showError, showNotFound };
}

describe("handleOpenCodeReference", () => {
  it("opens an existing workspace-root file at line/col", async () => {
    const { deps, revealInTextEditor } = makeDeps();
    await handleOpenCodeReference({ path: "src/foo.ts", line: 42, col: 7 }, deps as never);
    const [target, line, col] = revealInTextEditor.mock.calls[0];
    expect((target as { path: string }).path).toBe("/ws/src/foo.ts");
    expect(line).toBe(42);
    expect(col).toBe(7);
  });
  it("gives not-found feedback (not silent) for a missing file", async () => {
    const { deps, revealInTextEditor, showNotFound } = makeDeps({
      pathExists: vi.fn().mockResolvedValue(false),
    });
    await handleOpenCodeReference({ path: "src/missing.ts" }, deps as never);
    expect(revealInTextEditor).not.toHaveBeenCalled();
    expect(showNotFound).toHaveBeenCalledTimes(1);
  });
  it("silently declines (no reveal, no not-found) an out-of-workspace escape", async () => {
    const { deps, revealInTextEditor, showNotFound } = makeDeps();
    await handleOpenCodeReference({ path: "../../etc/passwd" }, deps as never);
    expect(revealInTextEditor).not.toHaveBeenCalled();
    expect(showNotFound).not.toHaveBeenCalled();
  });
  it("declines a .md target (open-link's domain)", async () => {
    const { deps, revealInTextEditor } = makeDeps();
    await handleOpenCodeReference({ path: "other.md" }, deps as never);
    expect(revealInTextEditor).not.toHaveBeenCalled();
  });
  it("tries each workspace folder, opens the first that exists", async () => {
    const exists = vi
      .fn()
      .mockImplementation((u: { path: string }) => Promise.resolve(u.path === "/ws2/src/foo.ts"));
    const { deps, revealInTextEditor } = makeDeps({
      workspaceFolderUris: [uri("/ws"), uri("/ws2")],
      pathExists: exists,
    });
    await handleOpenCodeReference({ path: "src/foo.ts" }, deps as never);
    expect((revealInTextEditor.mock.calls[0][0] as { path: string }).path).toBe("/ws2/src/foo.ts");
  });
  it("surfaces a failure toast when reveal throws", async () => {
    const { deps, showError } = makeDeps({
      revealInTextEditor: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await handleOpenCodeReference({ path: "src/foo.ts", line: 1 }, deps as never);
    expect(showError).toHaveBeenCalledTimes(1);
  });
  it("captures a synchronous joinPath throw as a failure toast (no unhandled rejection)", async () => {
    const { deps, showError } = makeDeps({
      joinPath: () => {
        throw new Error("bad uri");
      },
    });
    await handleOpenCodeReference({ path: "src/foo.ts" }, deps as never);
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
