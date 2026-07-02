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
});
