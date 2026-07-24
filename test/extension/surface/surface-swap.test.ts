import { describe, expect, it, vi } from "vitest";
import type { Tab, TextDocument, Uri } from "vscode";
import { window } from "vscode";
import {
  closeSourceTabIfClean,
  type FinalizeSwapDeps,
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
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps);
    expect(closeTab).not.toHaveBeenCalled();
    expect(reresolve).not.toHaveBeenCalled(); // gate refuses before re-resolving
  });

  it("does NOT close when save() throws (never reverts the shared working copy)", async () => {
    const doc = fakeDoc(true, "throw");
    const { deps, closeTab } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("saves a dirty doc clean, then closes the re-resolved live tab", async () => {
    const doc = fakeDoc(true, true);
    const { deps, closeTab, reresolve } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps);
    expect(reresolve).toHaveBeenCalledWith(SENTINEL_TAB);
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("closes a clean doc's source tab without saving", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps);
    expect(doc.save as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("does NOT close (and never throws) when the source tab is gone at re-resolve time", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab } = makeDeps(doc, { reresolveSourceTab: () => undefined });
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBeUndefined();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("never throws when the close is cancelled (closeTab resolves false)", async () => {
    const doc = fakeDoc(false, false);
    const closeTab = vi.fn(async () => false);
    const { deps } = makeDeps(doc, { closeTab });
    await expect(finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps)).resolves.toBeUndefined();
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
  });

  it("does nothing when there is no captured source tab", async () => {
    const doc = fakeDoc(false, false);
    const { deps, closeTab, reresolve } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, undefined, deps);
    expect(reresolve).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe("finalizeSurfaceSwap shouldAbortClose (point-of-no-return guard)", () => {
  const ABORT_REASON = "Quoll: can't switch while a change was rejected — fix it first.";

  it("does NOT close a clean doc when shouldAbortClose returns a reason", async () => {
    // Clean doc ⇒ shouldCloseSourceTab would allow the close; the abort guard
    // overrides it (e.g. a write-gate rejection is pending → keep both open).
    const doc = fakeDoc(false, true);
    const { deps, closeTab } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps, () => ABORT_REASON);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("shows the RETURNED reason as a warning toast (test-(c): a silent abort must fail the suite)", async () => {
    // The predicate returns a reason STRING and finalizeSurfaceSwap itself
    // surfaces it — the abort is user-visible by contract, not by caller
    // courtesy. At check time the user's focus is on the freshly opened text
    // tab, so a bare boolean predicate + no toast would let a silent abort pass;
    // this assertion is what pins the visible surface.
    const doc = fakeDoc(false, true);
    const { deps, closeTab } = makeDeps(doc);
    const warn = vi.spyOn(window, "showWarningMessage");
    try {
      await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps, () => ABORT_REASON);
      expect(closeTab).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(ABORT_REASON);
    } finally {
      warn.mockRestore();
    }
  });

  it("checks shouldAbortClose AFTER the openDoc await (closes the TOCTOU gap)", async () => {
    // The guard must observe a condition that becomes true DURING finalize's
    // awaits, not just at call time — mirrors a rejection that lands while
    // finalizeSurfaceSwap is awaiting openDoc. `pending` flips true inside
    // openDoc; the guard reads it AFTER that await and aborts the close.
    let pending = false;
    const doc = fakeDoc(false, true);
    const { deps, closeTab } = makeDeps(doc, {
      openDoc: async () => {
        pending = true;
        return doc;
      },
    });
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps, () => (pending ? ABORT_REASON : null));
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("checks shouldAbortClose AFTER the save await too (dirty-doc path)", async () => {
    // A dirty doc is saved before the close, so the guard must be re-checked
    // AFTER the save await as well — not only after openDoc. `pending` flips true
    // inside save(), mirroring a rejection that lands while finalize is saving.
    // Without an after-save check the dirty doc saves clean and closes.
    let pending = false;
    const state = { dirty: true };
    const doc = {
      uri: fileUri,
      get isDirty() {
        return state.dirty;
      },
      save: vi.fn(async () => {
        pending = true;
        state.dirty = false;
        return true;
      }),
    } as unknown as TextDocument;
    const { deps, closeTab } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps, () => (pending ? ABORT_REASON : null));
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("closes normally when shouldAbortClose returns null (guard does not block the happy path)", async () => {
    const doc = fakeDoc(false, true);
    const { deps, closeTab } = makeDeps(doc);
    await finalizeSurfaceSwap(fileUri, SENTINEL_TAB, deps, () => null);
    expect(closeTab).toHaveBeenCalledWith(LIVE_TAB);
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
