import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, TextDocument, Uri } from "vscode";
import {
  __clearSurfaceMemoryForTest,
  __getRememberedSurfaceForTest,
  noteSurface,
} from "../../../src/extension/surface/surface-memory.js";
import {
  closeSourceTabIfClean,
  type FinalizeSwapDeps,
  finalizeForwardSwap,
  finalizeSurfaceSwap,
  shouldCloseSourceTab,
} from "../../../src/extension/surface/surface-swap.js";

describe("shouldCloseSourceTab", () => {
  it("does not close when there is no source tab", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: false,
        wasDirty: false,
        saveSucceeded: false,
        stillDirtyAfterSave: false,
      })
    ).toBe(false);
  });

  it("closes a clean doc's source tab", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: false,
        saveSucceeded: false,
        stillDirtyAfterSave: false,
      })
    ).toBe(true);
  });

  it("closes when a dirty doc was saved clean", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: true,
        stillDirtyAfterSave: false,
      })
    ).toBe(true);
  });

  it("does NOT close when the save failed (avoids reverting the shared working copy)", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: false,
        stillDirtyAfterSave: true,
      })
    ).toBe(false);
  });

  it("does NOT close when the doc is still dirty after a 'successful' save", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: true,
        stillDirtyAfterSave: true,
      })
    ).toBe(false);
  });
});

// Integration coverage of finalizeSurfaceSwap's actual wiring (save-then-close
// orchestration) via the injectable seam — pins the data-loss guard and the
// defensive close arms that the E2E happy-paths never exercise.
const fileUri = { scheme: "file", toString: () => "file:///a.md" } as unknown as Uri;
const SENTINEL_TAB = { id: "captured" } as unknown as Tab;
const LIVE_TAB = { id: "live" } as unknown as Tab;

/** A minimal TextDocument fake whose `isDirty` reflects a `save()` that flips it
 *  clean on success (mirrors VS Code) and stays dirty on failure. */
function fakeDoc(startDirty: boolean, saveOutcome: boolean | "throw"): TextDocument {
  const state = { dirty: startDirty };
  return {
    uri: fileUri,
    get isDirty() {
      return state.dirty;
    },
    save: vi.fn(async () => {
      if (saveOutcome === "throw") {
        throw new Error("disk full");
      }
      if (saveOutcome === true) {
        state.dirty = false;
      }
      return saveOutcome;
    }),
  } as unknown as TextDocument;
}

function makeDeps(
  doc: TextDocument,
  overrides: Partial<FinalizeSwapDeps> = {}
): {
  deps: FinalizeSwapDeps;
  closeTab: ReturnType<typeof vi.fn>;
  reresolve: ReturnType<typeof vi.fn>;
} {
  const closeTab = vi.fn(async () => true);
  const reresolve = vi.fn(() => LIVE_TAB as Tab | undefined);
  const deps: FinalizeSwapDeps = {
    openDoc: async () => doc,
    reresolveSourceTab: reresolve,
    closeTab,
    ...overrides,
  };
  return { deps, closeTab, reresolve };
}

describe("finalizeSurfaceSwap", () => {
  it("does NOT close the source tab when a dirty doc's save() returns false (data-loss guard)", async () => {
    const doc = fakeDoc(true, false);
    const { deps, closeTab, reresolve } = makeDeps(doc);
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
    expect(reresolve).not.toHaveBeenCalled(); // gate refuses before re-resolving
  });

  it("does NOT close when save() throws (never reverts the shared working copy)", async () => {
    const doc = fakeDoc(true, "throw");
    const { deps, closeTab } = makeDeps(doc);
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("saves a dirty doc clean, then closes the re-resolved live tab", async () => {
    const doc = fakeDoc(true, true);
    const { deps, closeTab, reresolve } = makeDeps(doc);
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(true);
    expect(reresolve).toHaveBeenCalledWith(SENTINEL_TAB);
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("closes a clean doc's source tab without saving", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab } = makeDeps(doc);
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(true);
    expect(doc.save as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("does NOT close (and never throws) when the source tab is gone at re-resolve time", async () => {
    // Nothing left to close counts as a COMPLETED swap (outcome true).
    const doc = fakeDoc(false, false);
    const { deps, closeTab } = makeDeps(doc, { reresolveSourceTab: () => undefined });
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(true);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("never throws when the close is cancelled (closeTab resolves false)", async () => {
    const doc = fakeDoc(false, false);
    const closeTab = vi.fn(async () => false);
    const { deps } = makeDeps(doc, { closeTab });
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(false);
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("does nothing when there is no captured source tab", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab, reresolve } = makeDeps(doc);
    await expect(finalizeSurfaceSwap(fileUri, undefined, deps)).resolves.toBe(false);
    expect(reresolve).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("resolves false (and never throws) when openDoc rejects", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab } = makeDeps(doc, {
      openDoc: async () => {
        throw new Error("cannot open");
      },
    });
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe("finalizeForwardSwap (forward outcome → surface memory)", () => {
  // The wrapper records the swap OUTCOME after finalize settles: "text" only
  // when the swap completed, "quoll" otherwise — overriding the restore
  // watcher's sibling-adopt "text" written when the target tab opened.
  const KEY = fileUri.toString();

  beforeEach(() => __clearSurfaceMemoryForTest());

  /** A promise plus its resolver. The cases below use one as an "entered"
   *  signal (resolved when the fake dep is first called) so mid-flight asserts
   *  wait on a real event, never on a fixed microtask count. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it.each([
    ["a clean close", fakeDoc(false, false), {}],
    ["a saved-then-closed dirty doc", fakeDoc(true, true), {}],
    [
      "a source tab already gone at re-resolve",
      fakeDoc(false, false),
      { reresolveSourceTab: () => undefined },
    ],
  ] as const)('records "text" after %s', async (_label, doc, overrides) => {
    const { deps } = makeDeps(doc, overrides);
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
  });

  it('records "quoll" when a dirty doc\'s save() returns false', async () => {
    const { deps } = makeDeps(fakeDoc(true, false));
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when save() throws', async () => {
    const { deps } = makeDeps(fakeDoc(true, "throw"));
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when the close is cancelled', async () => {
    const { deps } = makeDeps(fakeDoc(false, false), { closeTab: vi.fn(async () => false) });
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when there is no captured source tab', async () => {
    const { deps } = makeDeps(fakeDoc(false, false));
    await finalizeForwardSwap(fileUri, undefined, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when openDoc rejects', async () => {
    const { deps } = makeDeps(fakeDoc(false, false), {
      openDoc: async () => {
        throw new Error("cannot open");
      },
    });
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('overwrites an earlier "text" (the watcher\'s sibling-adopt) with "quoll" on save false', async () => {
    noteSurface(KEY, "text");
    const { deps } = makeDeps(fakeDoc(true, false));
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  describe("writes only after finalize fully settles", () => {
    it('does not touch memory while openDoc is pending (save false → "quoll")', async () => {
      noteSurface(KEY, "text");
      const entered = deferred<void>();
      const open = deferred<TextDocument>();
      const { deps } = makeDeps(fakeDoc(true, false), {
        openDoc: () => {
          entered.resolve();
          return open.promise;
        },
      });
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
      await entered.promise;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
      open.resolve(fakeDoc(true, false));
      await run;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
    });

    it('does not touch memory while closeTab is pending (close true → "text")', async () => {
      noteSurface(KEY, "quoll");
      const entered = deferred<void>();
      const close = deferred<boolean>();
      const { deps } = makeDeps(fakeDoc(false, false), {
        closeTab: () => {
          entered.resolve();
          return close.promise;
        },
      });
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
      await entered.promise;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
      close.resolve(true);
      await run;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
    });

    it('does not touch memory while closeTab is pending (close false → "quoll")', async () => {
      noteSurface(KEY, "text");
      const entered = deferred<void>();
      const close = deferred<boolean>();
      const { deps } = makeDeps(fakeDoc(false, false), {
        closeTab: () => {
          entered.resolve();
          return close.promise;
        },
      });
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, deps);
      await entered.promise;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
      close.resolve(false);
      await run;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
    });
  });
});

describe("closeSourceTabIfClean (no-save passive restore finalizer)", () => {
  const uri = { toString: () => "file:///a.md", scheme: "file" } as unknown as Uri;
  const fakeTab = { input: {} } as unknown as Tab;

  it("does nothing when there is no source tab", async () => {
    let closed = false;
    await closeSourceTabIfClean(uri, undefined, {
      openDoc: async () => ({ isDirty: false }) as unknown as TextDocument,
      reresolveSourceTab: () => fakeTab,
      closeTab: async () => {
        closed = true;
        return true;
      },
    });
    expect(closed).toBe(false);
  });

  it("closes the re-resolved source tab when the doc is clean", async () => {
    let closedWith: Tab | null = null;
    await closeSourceTabIfClean(uri, fakeTab, {
      openDoc: async () => ({ isDirty: false }) as unknown as TextDocument,
      reresolveSourceTab: () => fakeTab,
      closeTab: async (t) => {
        closedWith = t;
        return true;
      },
    });
    expect(closedWith).toBe(fakeTab);
  });

  it("does NOT close (and never saves) when the doc is dirty", async () => {
    let closed = false;
    let saved = false;
    await closeSourceTabIfClean(uri, fakeTab, {
      // A save() on this fake would flip `saved`; closeSourceTabIfClean must
      // never call it.
      openDoc: async () =>
        ({
          isDirty: true,
          save: async () => {
            saved = true;
            return true;
          },
        }) as unknown as TextDocument,
      reresolveSourceTab: () => fakeTab,
      closeTab: async () => {
        closed = true;
        return true;
      },
    });
    expect(closed).toBe(false);
    expect(saved).toBe(false);
  });

  it("does not close when the source tab can no longer be re-resolved", async () => {
    let closed = false;
    await closeSourceTabIfClean(uri, fakeTab, {
      openDoc: async () => ({ isDirty: false }) as unknown as TextDocument,
      reresolveSourceTab: () => undefined,
      closeTab: async () => {
        closed = true;
        return true;
      },
    });
    expect(closed).toBe(false);
  });
});
