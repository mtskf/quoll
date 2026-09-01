import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildActiveGatedRevert,
  createDiskConflictWiring,
  shouldWatchDiskConflicts,
} from "../../../src/extension/conflict/disk-conflict-wiring.js";

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
      isPanelActive: () => false,
      revealPanel: () => {},
      subscribePanelViewStateChange: () => () => {},
      showError: () => {},
    });
    expect(() => wiring.dispose()).not.toThrow();
  });
});

describe("buildActiveGatedRevert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Build the gated-revert closure over stub deps. `confirmTimeoutMs: 10` keeps
  // fake-timer advances small; individual tests override the deps they exercise.
  function make(overrides: Partial<Parameters<typeof buildActiveGatedRevert>[0]> = {}) {
    let active = false;
    let viewStateCb: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const deps = {
      isDisposed: () => false,
      isActive: () => active,
      reveal: vi.fn(),
      subscribeViewStateChange: (cb: () => void) => {
        viewStateCb = cb;
        return unsubscribe;
      },
      revert: vi.fn(async () => undefined),
      confirmTimeoutMs: 10,
      ...overrides,
    };
    return {
      run: buildActiveGatedRevert(deps),
      deps,
      unsubscribe,
      setActive: (v: boolean) => {
        active = v;
      },
      fireViewState: () => viewStateCb(),
    };
  }

  it("reverts immediately when already active (sync fast-path, no reveal)", async () => {
    const w = make({ isActive: () => true });
    await w.run();
    expect(w.deps.revert).toHaveBeenCalledTimes(1);
    expect(w.deps.reveal).not.toHaveBeenCalled();
  });

  it("reveals, then reverts once the panel becomes active", async () => {
    const w = make();
    const p = w.run();
    expect(w.deps.reveal).toHaveBeenCalledTimes(1);
    w.setActive(true);
    w.fireViewState();
    await p;
    expect(w.deps.revert).toHaveBeenCalledTimes(1);
    expect(w.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does NOT revert when the panel never becomes active (timeout → skip: no unrelated-editor revert)", async () => {
    // The core contract: an argument-less workbench.action.files.revert hits the
    // ACTIVE editor. If our panel is not active, firing it could discard an
    // unrelated dirty file — so a timeout without active must skip the revert.
    const w = make();
    const p = w.run();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(w.deps.revert).not.toHaveBeenCalled();
    expect(w.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does NOT revert or reveal when already disposed", async () => {
    const w = make({ isDisposed: () => true });
    await w.run();
    expect(w.deps.revert).not.toHaveBeenCalled();
    expect(w.deps.reveal).not.toHaveBeenCalled();
  });

  it("resolves without throwing when disposed WHILE awaiting confirmation (dispose-race guard)", async () => {
    // The panel adapter's isActive() touches webviewPanel, which THROWS after
    // dispose. A view-state event arriving post-dispose must re-check isDisposed
    // and finish(false) WITHOUT reading isActive — else the read throws inside the
    // callback, the confirm Promise never settles, and the whole reload hangs.
    let disposed = false;
    const isActive = vi.fn(() => {
      if (disposed) {
        throw new Error("panel disposed");
      }
      return false;
    });
    const w = make({ isDisposed: () => disposed, isActive });
    const p = w.run();
    disposed = true;
    expect(() => w.fireViewState()).not.toThrow();
    await p;
    expect(w.deps.revert).not.toHaveBeenCalled();
  });

  it("resolves without throwing when disposed while waiting for the TIMEOUT (timer-path dispose-race guard)", async () => {
    // Pins the timer-callback dispose guard specifically: without a view-state
    // event, only the setTimeout path fires. If its `isDisposed() ? false :
    // isActive()` ternary were simplified to `isActive()`, the disposed stub's
    // throw would fire INSIDE the timer callback → the Promise never settles →
    // hang. This test drives the timer path (no fireViewState) so that guard is
    // falsifiable independently of the view-state path above.
    let disposed = false;
    const isActive = vi.fn(() => {
      if (disposed) {
        throw new Error("panel disposed");
      }
      return false;
    });
    const w = make({ isDisposed: () => disposed, isActive });
    const p = w.run();
    disposed = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeUndefined();
    expect(w.deps.revert).not.toHaveBeenCalled();
  });

  it("propagates a revert rejection so the watcher surfaces its error toast", async () => {
    const w = make({
      isActive: () => true,
      revert: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(w.run()).rejects.toThrow("boom");
  });

  it("tears down the subscription even if the view-state fires synchronously on subscribe", async () => {
    // Correct-by-construction guard: a subscribe that resolves the confirm
    // synchronously must still unsubscribe (else the real subscription leaks
    // until panel dispose). Not active on entry (so we pass the sync fast-path
    // and reach subscribe), then the reveal flips active and subscribe fires
    // onChange inline.
    let active = false;
    const unsubscribe = vi.fn();
    const revert = vi.fn(async () => undefined);
    const run = buildActiveGatedRevert({
      isDisposed: () => false,
      isActive: () => active,
      reveal: () => {
        active = true;
      },
      subscribeViewStateChange: (cb) => {
        cb(); // synchronous fire, mid-subscribe
        return unsubscribe;
      },
      revert,
      confirmTimeoutMs: 10,
    });
    await run();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
