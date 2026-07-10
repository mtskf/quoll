import { describe, expect, it } from "vitest";

import {
  createDiskConflictWiring,
  shouldWatchDiskConflicts,
} from "../../src/extension/disk-conflict-wiring.js";

describe("shouldWatchDiskConflicts", () => {
  it("watches file-scheme documents (a real backing disk to diverge from)", () => {
    expect(shouldWatchDiskConflicts("file")).toBe(true);
  });

  it("does not watch non-file schemes (no backing disk / createFileSystemWatcher needs a path)", () => {
    for (const scheme of ["untitled", "git", "vscode-userdata", "vscode-vfs", "http", "https"]) {
      expect(shouldWatchDiskConflicts(scheme)).toBe(false);
    }
  });
});

describe("createDiskConflictWiring", () => {
  it("returns an inert no-op wiring for a non-file document without creating a watcher", () => {
    // A non-file doc must short-circuit BEFORE any workspace.createFileSystemWatcher
    // call — the vscode stub has no watcher support, so if the gate regressed this
    // would throw. dispose() must also be a safe no-op.
    const wiring = createDiskConflictWiring({
      documentUri: { scheme: "untitled", toString: () => "untitled:Untitled-1" } as never,
      isDisposed: () => false,
      isDirty: () => false,
      readBufferText: () => "",
      promptOverride: () => null,
      revealPanel: () => {},
      showError: () => {},
    });
    expect(() => wiring.dispose()).not.toThrow();
  });
});
