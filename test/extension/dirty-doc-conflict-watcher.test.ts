import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFLICT_DEBOUNCE_MS,
  createDirtyDocConflictWatcher,
  type DirtyDocConflictWatcherDeps,
} from "../../src/extension/dirty-doc-conflict-watcher.js";

const URI = "file:///doc.md";
const RELOAD = "Reload from disk";
const DEBOUNCE = 10;

// Build a watcher over spies with sensible "divergent + dirty + reload" defaults
// (the path that actually reloads). `emit` fires a raw signal into the captured
// subscription handler; individual tests override only the deps they exercise.
function makeWatcher(overrides: Partial<DirtyDocConflictWatcherDeps> = {}) {
  let onSignal: ((changedUriString: string) => void) | null = null;
  let unsubscribed = false;
  const spies = {
    readDiskText: vi.fn(async () => "disk-content"),
    readBufferText: vi.fn(() => "buffer-content"),
    promptReload: vi.fn(async (): Promise<string | undefined> => RELOAD),
    reloadFromDisk: vi.fn(async () => undefined),
    showError: vi.fn(),
  };
  let dirty = true;
  let disposed = false;
  const deps: DirtyDocConflictWatcherDeps = {
    subscribe: (handler) => {
      onSignal = handler;
      return () => {
        unsubscribed = true;
      };
    },
    documentUriString: URI,
    isDisposed: () => disposed,
    isDirty: () => dirty,
    readDiskText: spies.readDiskText,
    readBufferText: spies.readBufferText,
    promptReload: spies.promptReload,
    reloadChoice: RELOAD,
    reloadFromDisk: spies.reloadFromDisk,
    showError: spies.showError,
    debounceMs: DEBOUNCE,
    ...overrides,
  };
  const watcher = createDirtyDocConflictWatcher(deps);
  return {
    watcher,
    spies,
    emit: (uri = URI) => {
      if (onSignal === null) {
        throw new Error("subscribe handler not captured");
      }
      onSignal(uri);
    },
    setDirty: (v: boolean) => {
      dirty = v;
    },
    setDisposed: (v: boolean) => {
      disposed = v;
    },
    isUnsubscribed: () => unsubscribed,
  };
}

// Fire the debounce and flush the async checkConflict chain.
async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE);
}

describe("createDirtyDocConflictWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("exports the shared debounce constant", () => {
    expect(CONFLICT_DEBOUNCE_MS).toBe(300);
  });

  it("debounces a burst of signals into ONE conflict check", async () => {
    const w = makeWatcher();
    w.emit();
    w.emit();
    w.emit();
    await fireDebounce();
    expect(w.spies.readDiskText).toHaveBeenCalledTimes(1);
    expect(w.spies.reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  it("ignores signals for a different URI", async () => {
    const w = makeWatcher();
    w.emit("file:///other.md");
    await fireDebounce();
    expect(w.spies.readDiskText).not.toHaveBeenCalled();
  });

  it("early-exits without a disk read when the model is clean", async () => {
    const w = makeWatcher();
    w.setDirty(false);
    w.emit();
    await fireDebounce();
    expect(w.spies.readDiskText).not.toHaveBeenCalled();
    expect(w.spies.promptReload).not.toHaveBeenCalled();
  });

  it("does not prompt when disk and buffer do not diverge", async () => {
    const w = makeWatcher({
      readDiskText: vi.fn(async () => "same"),
      readBufferText: vi.fn(() => "same"),
    });
    w.emit();
    await fireDebounce();
    expect(w.spies.promptReload).not.toHaveBeenCalled();
  });

  it("single-flights: a second debounce fire during an in-flight read starts no second action", async () => {
    let releaseRead: (v: string) => void = () => undefined;
    const readDiskText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        })
    );
    const w = makeWatcher({ readDiskText });
    w.emit();
    await fireDebounce(); // claims the flag, blocks on the read
    expect(readDiskText).toHaveBeenCalledTimes(1);

    // A second burst fires while the first action is still in flight.
    w.emit();
    await fireDebounce();
    expect(readDiskText).toHaveBeenCalledTimes(1); // flag blocked the re-entry

    releaseRead("disk-content");
    await vi.runAllTimersAsync();
  });

  it("reloads on the reload choice, no error toast on a clean revert", async () => {
    const w = makeWatcher();
    w.setDirty(true);
    // The reload clears dirty (true revert).
    w.spies.reloadFromDisk.mockImplementation(async () => {
      w.setDirty(false);
    });
    w.emit();
    await fireDebounce();
    expect(w.spies.reloadFromDisk).toHaveBeenCalledTimes(1);
    expect(w.spies.showError).not.toHaveBeenCalled();
  });

  it("surfaces an error when the revert silently no-ops (still dirty afterwards)", async () => {
    const w = makeWatcher(); // reloadFromDisk resolves but dirty stays true
    w.emit();
    await fireDebounce();
    expect(w.spies.reloadFromDisk).toHaveBeenCalledTimes(1);
    expect(w.spies.showError).toHaveBeenCalledTimes(1);
    expect(w.spies.showError.mock.calls[0]?.[0]).toContain("Revert File");
  });

  it("keeps edits (no reload, no error) when the user dismisses the prompt", async () => {
    const w = makeWatcher({ promptReload: vi.fn(async () => "Keep my edits") });
    w.emit();
    await fireDebounce();
    expect(w.spies.reloadFromDisk).not.toHaveBeenCalled();
    expect(w.spies.showError).not.toHaveBeenCalled();
  });

  it("warns and returns (no prompt, no toast) when the disk read fails; flag releases", async () => {
    const readDiskText = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValue("disk-content");
    const w = makeWatcher({ readDiskText });
    w.emit();
    await fireDebounce();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(w.spies.promptReload).not.toHaveBeenCalled();
    expect(w.spies.showError).not.toHaveBeenCalled();

    // Flag released → a later signal runs a fresh action.
    w.emit();
    await fireDebounce();
    expect(readDiskText).toHaveBeenCalledTimes(2);
    expect(w.spies.reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  it("logs an error and surfaces a toast when the reload throws", async () => {
    const w = makeWatcher({
      reloadFromDisk: vi.fn(async () => {
        throw new Error("revert boom");
      }),
    });
    w.emit();
    await fireDebounce();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(w.spies.showError).toHaveBeenCalledTimes(1);
    expect(w.spies.showError.mock.calls[0]?.[0]).toContain("revert boom");
  });

  it("does not prompt when disposed after the disk read", async () => {
    const w = makeWatcher();
    w.spies.readDiskText.mockImplementation(async () => {
      w.setDisposed(true);
      return "disk-content";
    });
    w.emit();
    await fireDebounce();
    expect(w.spies.promptReload).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending debounce and tears down the subscription", async () => {
    const w = makeWatcher();
    w.emit();
    w.watcher.dispose();
    expect(w.isUnsubscribed()).toBe(true);
    await vi.runAllTimersAsync();
    expect(w.spies.readDiskText).not.toHaveBeenCalled();
  });
});
