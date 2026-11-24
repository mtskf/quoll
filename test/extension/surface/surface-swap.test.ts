import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Tab, type TextDocument, type Uri, window } from "vscode";
import {
  __clearSurfaceMemoryForTest,
  __getRememberedSurfaceForTest,
  claimSurface,
  noteSurface,
} from "../../../src/extension/surface/surface-memory.js";
import {
  closeSourceTabIfClean,
  type FinalizeSwapDeps,
  finalizeForwardSwap,
  finalizeSurfaceSwap,
  runForwardSwitch,
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
const KEY = fileUri.toString();
const SENTINEL_TAB = { id: "captured" } as unknown as Tab;
const LIVE_TAB = { id: "live" } as unknown as Tab;

beforeEach(() => __clearSurfaceMemoryForTest());

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

/** A promise plus its resolver for pausing the operation at an await boundary. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("finalizeForwardSwap (forward outcome → surface memory)", () => {
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
    await expect(finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps)).resolves.toBe(
      true
    );
    expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
  });

  it('records "quoll" when a dirty doc\'s save() returns false', async () => {
    const { deps } = makeDeps(fakeDoc(true, false));
    await expect(finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps)).resolves.toBe(
      false
    );
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when save() throws', async () => {
    const { deps } = makeDeps(fakeDoc(true, "throw"));
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when the close is cancelled', async () => {
    const { deps } = makeDeps(fakeDoc(false, false), { closeTab: vi.fn(async () => false) });
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when there is no captured source tab', async () => {
    const { deps } = makeDeps(fakeDoc(false, false));
    await finalizeForwardSwap(fileUri, undefined, claimSurface(KEY), deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it('records "quoll" when openDoc rejects', async () => {
    const { deps } = makeDeps(fakeDoc(false, false), {
      openDoc: async () => {
        throw new Error("cannot open");
      },
    });
    await finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it("skips save and close when superseded before save", async () => {
    const doc = fakeDoc(true, true);
    const open = deferred<TextDocument>();
    const { deps, closeTab } = makeDeps(doc, { openDoc: () => open.promise });
    const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
    noteSurface(KEY, "quoll");
    open.resolve(doc);

    expect.soft(await run).toBe(false);
    expect.soft(doc.save).not.toHaveBeenCalled();
    expect.soft(closeTab).not.toHaveBeenCalled();
    expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
  });

  it.each([
    true,
    false,
  ])("skips warning and close and preserves newer memory when superseded during save (save returns %s)", async (saved) => {
    const warning = vi.spyOn(window, "showWarningMessage");
    try {
      const entered = deferred<void>();
      const save = deferred<boolean>();
      let dirty = true;
      const doc = {
        uri: fileUri,
        get isDirty() {
          return dirty;
        },
        save: () => {
          entered.resolve();
          return save.promise;
        },
      } as unknown as TextDocument;
      const { deps, closeTab } = makeDeps(doc);
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
      await entered.promise;
      const newerSurface = saved ? "quoll" : "text";
      noteSurface(KEY, newerSurface);
      dirty = !saved;
      save.resolve(saved);

      expect.soft(await run).toBe(false);
      expect.soft(warning).not.toHaveBeenCalled();
      expect.soft(closeTab).not.toHaveBeenCalled();
      expect(__getRememberedSurfaceForTest(KEY)).toBe(newerSurface);
    } finally {
      warning.mockRestore();
    }
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
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
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
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
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
      const run = finalizeForwardSwap(fileUri, SENTINEL_TAB, claimSurface(KEY), deps);
      await entered.promise;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
      close.resolve(false);
      await run;
      expect(__getRememberedSurfaceForTest(KEY)).toBe("quoll");
    });
  });
});

describe("runForwardSwitch", () => {
  function setup() {
    let sideChannel: (() => void) | undefined;
    let onDrop: (() => void) | undefined;
    const barrier = {
      run(run: () => void, drop?: () => void) {
        sideChannel = run;
        onDrop = drop;
      },
    };
    const deps = {
      barrier,
      claim: vi.fn(() => claimSurface(KEY)),
      open: vi.fn<() => Promise<unknown>>(async () => undefined),
      restoreCaret: vi.fn(),
      finalize: vi.fn(async () => true),
      postAborted: vi.fn(),
      onError: vi.fn(),
    };
    return {
      deps,
      run: () => sideChannel?.(),
      drop: () => onDrop?.(),
    };
  }

  it.each([
    "synchronous open",
    "rejected open",
    "caret",
    "finalize",
  ])("posts an abort on %s failure", async (failure) => {
    const test = setup();
    if (failure === "synchronous open") {
      test.deps.open.mockImplementation(() => {
        throw new Error("open");
      });
    } else if (failure === "rejected open") {
      test.deps.open.mockRejectedValue(new Error("open"));
    } else if (failure === "caret") {
      test.deps.restoreCaret.mockImplementation(() => {
        throw new Error("caret");
      });
    } else {
      test.deps.finalize.mockResolvedValue(false);
    }
    runForwardSwitch(test.deps);
    test.run();
    await vi.waitFor(() => expect(test.deps.postAborted).toHaveBeenCalledOnce());
    expect(test.deps.open).toHaveBeenCalledOnce();
    expect(test.deps.restoreCaret).toHaveBeenCalledTimes(
      failure === "caret" || failure === "finalize" ? 1 : 0
    );
    expect(test.deps.finalize).toHaveBeenCalledTimes(failure === "finalize" ? 1 : 0);
  });

  it("aborts without restoring the caret or finalizing when superseded during open", async () => {
    const test = setup();
    const open = deferred<void>();
    test.deps.open.mockReturnValue(open.promise);
    runForwardSwitch(test.deps);
    expect(test.deps.claim).not.toHaveBeenCalled();
    test.run();
    expect(test.deps.claim).toHaveBeenCalledBefore(test.deps.open);
    expect(test.deps.open).toHaveBeenCalledOnce();
    noteSurface(KEY, "quoll");
    open.resolve();
    await open.promise;
    expect.soft(test.deps.postAborted).toHaveBeenCalledOnce();
    expect.soft(test.deps.restoreCaret).not.toHaveBeenCalled();
    expect(test.deps.finalize).not.toHaveBeenCalled();
  });

  it("posts an abort when the barrier drops the operation", () => {
    const test = setup();
    runForwardSwitch(test.deps);
    test.drop();
    expect(test.deps.postAborted).toHaveBeenCalledOnce();
    expect(test.deps.claim).not.toHaveBeenCalled();
    expect(test.deps.open).not.toHaveBeenCalled();
    expect(test.deps.restoreCaret).not.toHaveBeenCalled();
    expect(test.deps.finalize).not.toHaveBeenCalled();
  });

  it("can run successfully after a synchronous open throw", async () => {
    const test = setup();
    test.deps.open.mockImplementationOnce(() => {
      throw new Error("open");
    });
    runForwardSwitch(test.deps);
    test.run();
    await vi.waitFor(() => expect(test.deps.postAborted).toHaveBeenCalledOnce());
    test.deps.postAborted.mockClear();
    test.deps.open.mockClear();
    runForwardSwitch(test.deps);
    test.run();
    await vi.waitFor(() => expect(test.deps.finalize).toHaveBeenCalledOnce());
    expect(test.deps.open).toHaveBeenCalledOnce();
    expect(test.deps.postAborted).not.toHaveBeenCalled();
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
