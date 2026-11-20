import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFLICT_DEBOUNCE_MS,
  createDirtyDocConflictWatcher,
  type DirtyDocConflictWatcherDeps,
} from "../../../src/extension/conflict/dirty-doc-conflict-watcher.js";

const URI = "file:///doc.md";
const RELOAD = "Reload from disk";
const DEBOUNCE = 10;

// Build a watcher over spies with sensible "divergent + dirty + reload" defaults
// (the path that actually reloads). `emit` fires a raw signal into the captured
// subscription handler; individual tests override only the deps they exercise.
function makeWatcher(overrides: Partial<DirtyDocConflictWatcherDeps> = {}) {
  let onSignal: ((changedUriString: string) => void) | null = null;
  let onSave: (() => void) | null = null;
  let unsubscribed = false;
  let saveUnsubscribed = false;
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
    subscribeSave: (handler) => {
      onSave = handler;
      return () => {
        saveUnsubscribed = true;
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
    // The platform's save notification for the watched doc.
    save: () => {
      if (onSave === null) {
        throw new Error("save handler not captured");
      }
      onSave();
    },
    setDirty: (v: boolean) => {
      dirty = v;
    },
    setDisposed: (v: boolean) => {
      disposed = v;
    },
    isUnsubscribed: () => unsubscribed && saveUnsubscribed,
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

  it("skips the disk read when the model is clean and no save is tracked", async () => {
    const w = makeWatcher();
    w.setDirty(false);
    w.emit();
    await fireDebounce();
    expect(w.spies.readDiskText).not.toHaveBeenCalled();
    expect(w.spies.promptReload).not.toHaveBeenCalled();
  });

  it("does not prompt when the disk read is untrusted (null: non-UTF-8 content)", async () => {
    const w = makeWatcher({ readDiskText: vi.fn(async () => null) });
    w.emit();
    await fireDebounce();
    expect(w.spies.promptReload).not.toHaveBeenCalled();
    expect(w.spies.reloadFromDisk).not.toHaveBeenCalled();
    expect(w.spies.showError).not.toHaveBeenCalled();
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

  describe("checks requested during an in-flight action", () => {
    // A read that stays pending until the test releases it (or fails it).
    function heldRead() {
      let release: (v: string) => void = () => undefined;
      let fail: (e: Error) => void = () => undefined;
      let reads = 0;
      let concurrent = 0;
      let maxConcurrent = 0;
      const readDiskText = vi.fn(async (): Promise<string | null> => {
        reads++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (reads === 1) {
            return await new Promise<string>((resolve, reject) => {
              release = resolve;
              fail = reject;
            });
          }
          return "disk-content";
        } finally {
          concurrent--;
        }
      });
      return {
        readDiskText,
        release: (v: string) => release(v),
        fail: (e: Error) => fail(e),
        maxConcurrent: () => maxConcurrent,
      };
    }

    it("rechecks after the read when a write landed during it, never reading concurrently", async () => {
      const r = heldRead();
      const w = makeWatcher({ readDiskText: r.readDiskText });
      w.emit();
      await fireDebounce(); // first read in flight
      w.emit(); // an external write lands while it is pending
      await fireDebounce();
      w.emit();
      await fireDebounce();
      expect(r.readDiskText).toHaveBeenCalledTimes(1);

      r.release("buffer-content"); // the stale snapshot: no divergence yet
      await vi.runAllTimersAsync();
      expect(r.readDiskText).toHaveBeenCalledTimes(2); // the requests coalesced
      expect(r.maxConcurrent()).toBe(1);
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
    });

    it("keeps the request when the in-flight read fails", async () => {
      const r = heldRead();
      const w = makeWatcher({ readDiskText: r.readDiskText });
      w.emit();
      await fireDebounce();
      w.emit();
      await fireDebounce();

      r.fail(new Error("EBUSY"));
      await vi.runAllTimersAsync();
      expect(r.readDiskText).toHaveBeenCalledTimes(2);
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
    });

    it("does not recheck after an action that prompted", async () => {
      let answer: (v: string | undefined) => void = () => undefined;
      const promptReload = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            answer = resolve;
          })
      );
      const w = makeWatcher({ promptReload });
      w.emit();
      await fireDebounce(); // prompt open
      w.emit();
      await fireDebounce();

      answer(undefined); // keep my edits
      await vi.runAllTimersAsync();
      expect(w.spies.readDiskText).toHaveBeenCalledTimes(1);
      expect(promptReload).toHaveBeenCalledTimes(1);
    });

    it("drops the request when the watcher is disposed during the read", async () => {
      const r = heldRead();
      const w = makeWatcher({ readDiskText: r.readDiskText });
      w.emit();
      await fireDebounce();
      w.emit();
      await fireDebounce();

      w.watcher.dispose();
      r.release("buffer-content");
      await vi.runAllTimersAsync();
      expect(r.readDiskText).toHaveBeenCalledTimes(1);
    });
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

  it("does not reload when disposed while the prompt is open (pins the mid-prompt dispose guard)", async () => {
    // Dispose races the open prompt: the line-106 `isDisposed()` disjunct must
    // short-circuit before reloadFromDisk runs against a torn-down panel.
    const w = makeWatcher();
    w.spies.promptReload.mockImplementation(async () => {
      w.setDisposed(true);
      return RELOAD;
    });
    w.emit();
    await fireDebounce();
    expect(w.spies.reloadFromDisk).not.toHaveBeenCalled();
  });

  it("suppresses the still-dirty error toast when disposed during the reload (pins the post-condition dispose guard)", async () => {
    // reloadFromDisk resolves but leaves the model dirty AND disposes the panel:
    // the line-116 `!isDisposed()` disjunct must suppress the manual-revert
    // toast (without it, the still-dirty branch would fire showError).
    const w = makeWatcher();
    w.spies.reloadFromDisk.mockImplementation(async () => {
      w.setDisposed(true);
    });
    w.emit();
    await fireDebounce();
    expect(w.spies.reloadFromDisk).toHaveBeenCalledTimes(1);
    expect(w.spies.showError).not.toHaveBeenCalled();
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

  describe("own saves", () => {
    // Timeline: this document saves `saved\n` (clean at the save notification),
    // the save's own fs signal arrives, and the user appends before the debounce
    // fires. `disk` is what the conflict check then reads.
    function savedThenAppended(disk: string) {
      let buffer = "saved\n";
      const readDiskText = vi.fn(async (): Promise<string | null> => disk);
      const w = makeWatcher({ readDiskText, readBufferText: () => buffer });
      w.setDirty(false);
      w.save();
      w.emit();
      buffer = "saved\nappended\n";
      w.setDirty(true);
      return { ...w, readDiskText };
    }

    it("does not prompt when a self-save is followed by an append before the check", async () => {
      const w = savedThenAppended("saved\n");
      await fireDebounce();
      expect(w.readDiskText).toHaveBeenCalledTimes(1);
      expect(w.spies.promptReload).not.toHaveBeenCalled();
    });

    it("compares the saved content with the same BOM/EOL normalization", async () => {
      const w = savedThenAppended("saved\r\n");
      await fireDebounce();
      expect(w.spies.promptReload).not.toHaveBeenCalled();
    });

    it("still prompts for a different external write right after a self-save", async () => {
      const w = savedThenAppended("external\n");
      await fireDebounce();
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
    });

    it("keeps recognising its save across a repeated fs signal for the same bytes", async () => {
      const w = savedThenAppended("saved\n");
      await fireDebounce();
      w.emit();
      await fireDebounce();
      expect(w.readDiskText).toHaveBeenCalledTimes(2);
      expect(w.spies.promptReload).not.toHaveBeenCalled();
    });

    it("forgets the save once disk is seen to hold other bytes, so a write-back of them prompts", async () => {
      // e.g. a branch switch away and back: disk leaves our save while the doc is
      // clean (VS Code reloads it), the user edits, then disk returns to the
      // bytes we once saved. That is an external change to the reloaded text.
      let buffer = "saved\n";
      let disk = "saved\n";
      const w = makeWatcher({
        readDiskText: vi.fn(async () => disk),
        readBufferText: () => buffer,
      });
      w.setDirty(false);
      w.save();
      disk = "other\n";
      buffer = "other\n"; // the platform's clean auto-reload
      w.emit();
      await fireDebounce();
      buffer = "other\nedited\n";
      w.setDirty(true);
      disk = "saved\n";
      w.emit();
      await fireDebounce();
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
    });

    it("ignores a save notified while the model is still dirty (the saved bytes are unknown)", async () => {
      let buffer = "saved\nmore\n";
      const w = makeWatcher({
        readDiskText: vi.fn(async () => "saved\nmore\n"),
        readBufferText: () => buffer,
      });
      w.save(); // dirty at the notification: the buffer is not what was written
      buffer = "saved\nmore\nagain\n";
      w.emit();
      await fireDebounce();
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
    });

    it("discards a disk read that a save overtook, without forgetting that save", async () => {
      let buffer = "old\nedit\n";
      let releaseRead: (v: string) => void = () => undefined;
      const readDiskText = vi
        .fn<() => Promise<string | null>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              releaseRead = resolve;
            })
        )
        .mockResolvedValue("new\n");
      const w = makeWatcher({ readDiskText, readBufferText: () => buffer });
      w.emit();
      await fireDebounce(); // read in flight
      buffer = "new\n";
      w.setDirty(false);
      w.save(); // the save lands mid-read
      buffer = "new\nappended\n";
      w.setDirty(true);
      releaseRead("old\n"); // the pre-save bytes
      await Promise.resolve();
      expect(w.spies.promptReload).not.toHaveBeenCalled();
      // The retry recognises the save without another signal.
      await fireDebounce();
      expect(readDiskText).toHaveBeenCalledTimes(2);
      expect(w.spies.promptReload).not.toHaveBeenCalled();
    });

    it("does not retry a disk read overtaken by a save after the watcher is disposed", async () => {
      let buffer = "old\nedit\n";
      let releaseRead: (v: string) => void = () => undefined;
      const readDiskText = vi
        .fn<() => Promise<string | null>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              releaseRead = resolve;
            })
        )
        .mockResolvedValue("new\n");
      const w = makeWatcher({ readDiskText, readBufferText: () => buffer });
      w.emit();
      await fireDebounce();

      buffer = "new\n";
      w.setDirty(false);
      w.save();
      buffer = "new\nappended\n";
      w.setDirty(true);
      w.watcher.dispose();

      releaseRead("old\n");
      await vi.runAllTimersAsync();
      expect(readDiskText).toHaveBeenCalledTimes(1);
      expect(w.spies.promptReload).not.toHaveBeenCalled();
    });

    it("retries an external write whose debounce fired during a read overtaken by a save", async () => {
      let buffer = "old\nedit\n";
      let releaseRead: (v: string) => void = () => undefined;
      const readDiskText = vi.fn<() => Promise<string | null>>().mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseRead = resolve;
          })
      );
      const w = makeWatcher({ readDiskText, readBufferText: () => buffer });
      w.spies.promptReload.mockResolvedValue(undefined);
      w.emit();
      await fireDebounce();

      buffer = "new\n";
      w.setDirty(false);
      w.save();
      buffer = "new\nappended\n";
      w.setDirty(true);

      readDiskText.mockResolvedValue("external\n");
      w.emit();
      await fireDebounce();
      expect(readDiskText).toHaveBeenCalledTimes(1);
      expect(w.spies.promptReload).not.toHaveBeenCalled();

      releaseRead("old\n");
      await vi.runAllTimersAsync();
      expect(w.spies.promptReload).toHaveBeenCalledTimes(1);
      expect(readDiskText).toHaveBeenCalledTimes(2);
    });
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
