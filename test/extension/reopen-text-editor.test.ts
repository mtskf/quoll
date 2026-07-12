import { describe, expect, it, vi } from "vitest";

import type { Uri } from "vscode";
import {
  DEFAULT_TEXT_EDITOR_VIEW_TYPE,
  openInTextEditor,
} from "../../src/extension/surface/reopen-text-editor.js";

describe("openInTextEditor", () => {
  it("reopens the uri in the built-in text editor via vscode.openWith", async () => {
    const exec = vi.fn(async () => undefined);
    const uri = { path: "/notes/a.md" } as unknown as Uri;
    await openInTextEditor(uri, exec);
    expect(exec).toHaveBeenCalledWith("vscode.openWith", uri, "default");
  });

  it("pins the default text-editor viewType id", () => {
    expect(DEFAULT_TEXT_EDITOR_VIEW_TYPE).toBe("default");
  });
});
