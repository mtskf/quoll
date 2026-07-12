import { describe, expect, it } from "vitest";
import { openInQuollEditor } from "../../src/extension/surface/open-in-quoll.js";

describe("openInQuollEditor", () => {
  it("invokes vscode.openWith with the uri and the given view type", () => {
    const calls: unknown[][] = [];
    const exec = (command: string, ...rest: unknown[]) => {
      calls.push([command, ...rest]);
      return Promise.resolve(undefined);
    };
    const uri = { path: "/ws/notes/other.md" } as unknown as import("vscode").Uri;
    void openInQuollEditor(uri, "quoll.editMarkdown", exec);
    expect(calls).toEqual([["vscode.openWith", uri, "quoll.editMarkdown"]]);
  });
});
