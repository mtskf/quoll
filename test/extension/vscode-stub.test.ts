import { describe, expect, it } from "vitest";

import { Uri } from "./vscode-stub.js";

describe("vscode-stub Uri.joinPath", () => {
  it("joins plain segments (unchanged behavior)", () => {
    expect(Uri.joinPath({ path: "ext" }, "dist", "webview").path).toBe("ext/dist/webview");
  });

  it("collapses a trailing .. to the parent folder (absolute)", () => {
    expect(Uri.joinPath({ path: "/ws/notes/a.md" }, "..").path).toBe("/ws/notes");
  });

  it("collapses . segments and preserves the leading slash", () => {
    expect(Uri.joinPath({ path: "/ws" }, ".", "notes").path).toBe("/ws/notes");
  });

  it("preserves the file scheme and exposes the joined fsPath", () => {
    expect(Uri.joinPath({ path: "/a", scheme: "file" }, "..", "b")).toEqual({
      scheme: "file",
      path: "/b",
      fsPath: "/b",
    });
  });

  it("omits scheme when the base has none", () => {
    expect(Uri.joinPath({ path: "/a" }, "b")).toEqual({ path: "/a/b", fsPath: "/a/b" });
  });
});
