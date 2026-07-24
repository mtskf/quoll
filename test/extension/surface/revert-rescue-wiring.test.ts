import { afterEach, describe, expect, it, vi } from "vitest";
import { workspace } from "vscode";

import { createRevertRescueWiring } from "../../../src/extension/surface/revert-rescue-wiring.js";

// Flush the microtask queue so the fire-and-forget `void workspace.applyEdit(...)`
// promise settles before assertions.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A minimal fake TextDocument: getText returns the current mutable buffer, version
// is a settable counter, positionAt returns a stub position (offsets are not
// asserted — the WorkspaceEdit build is exercised by e2e). isDirty is settable.
function makeDoc() {
  return {
    text: "DISK",
    version: 1,
    isDirty: false,
    uri: { scheme: "file", toString: () => "file:///doc.md" },
    getText(): string {
      return this.text;
    },
    positionAt(offset: number): unknown {
      return { line: 0, character: offset };
    },
  };
}

type Wired = {
  wiring: ReturnType<typeof createRevertRescueWiring>;
  doc: ReturnType<typeof makeDoc>;
  fireDocChange: () => void;
  fireTabClose: () => void;
  writeLock: { held: boolean };
  disposedFlag: { value: boolean };
  survivingFlag: { value: boolean };
  dispatched: number[];
  showErrors: string[];
};

function wire(): Wired {
  const doc = makeDoc();
  const writeLock = { held: false };
  const disposedFlag = { value: false };
  const survivingFlag = { value: true };
  const dispatched: number[] = [];
  const showErrors: string[] = [];
  let onDocChange: (() => void) | null = null;
  let onTabClose: (() => void) | null = null;

  const wiring = createRevertRescueWiring({
    document: doc as never,
    isDisposed: () => disposedFlag.value,
    isWriteLockHeld: () => writeLock.held,
    canWrite: () => true,
    hasSurvivingEditor: () => survivingFlag.value,
    dispatchDocumentChanged: (v) => dispatched.push(v),
    showError: (m) => showErrors.push(m),
    subscribeDocumentChange: (cb) => {
      onDocChange = cb;
      return () => {
        onDocChange = null;
      };
    },
    subscribeTextTabClose: (cb) => {
      onTabClose = cb;
      return () => {
        onTabClose = null;
      };
    },
  });

  return {
    wiring,
    doc,
    fireDocChange: () => onDocChange?.(),
    fireTabClose: () => onTabClose?.(),
    writeLock,
    disposedFlag,
    survivingFlag,
    dispatched,
    showErrors,
  };
}

// Arm a close-triggered revert: a dirty edit, then a clean event whose content
// DIFFERS from the last dirty bytes (a revert, not a save → arms pendingRevert).
function armRevert(t: Wired): void {
  t.doc.text = "DIRTY";
  t.doc.isDirty = true;
  t.fireDocChange();
  t.doc.text = "DISK";
  t.doc.isDirty = false;
  t.fireDocChange();
}

describe("createRevertRescueWiring — dispose rescue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshots the write-lock at prepareDispose, NOT at rescueOnDispose (ordering pin)", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit");
    armRevert(t);

    // Lock is HELD at prepareDispose (an apply is in flight) → snapshot true.
    t.writeLock.held = true;
    t.wiring.prepareDispose();
    // The disposed transition then clears the lock. rescueOnDispose must use the
    // SNAPSHOT (true), so NO rescue fires despite the lock now reading free.
    t.writeLock.held = false;
    t.wiring.rescueOnDispose();
    await flush();

    expect(applySpy).not.toHaveBeenCalled();
  });

  it("rescues on dispose when the write-lock was free at prepareDispose", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.text = "DIRTY"; // applied lands the restored bytes
      return true;
    });
    armRevert(t);

    t.writeLock.held = false;
    t.wiring.prepareDispose();
    t.wiring.rescueOnDispose();
    await flush();

    expect(applySpy).toHaveBeenCalledOnce();
    expect(t.showErrors).toEqual([]); // applied → silent
  });

  it("does NOT rescue on dispose when no surviving editor holds the document", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit");
    armRevert(t);

    t.survivingFlag.value = false; // last holder — VS Code's revert is the intended UX
    t.wiring.prepareDispose();
    t.wiring.rescueOnDispose();
    await flush();

    expect(applySpy).not.toHaveBeenCalled();
  });

  it("on dispose-path restore FAILURE shows an error and does NOT reseed (no onFailure)", async () => {
    // The dispose path calls applyRestoreEdit(content) with NO onFailure (the
    // panel is gone — nothing to reseed). This pins the asymmetry vs the alive
    // path: showError still fires (applyRestoreEdit surfaces failure
    // unconditionally), but dispatched stays empty (the undefined-onFailure arm).
    const t = wire();
    vi.spyOn(workspace, "applyEdit").mockResolvedValue(false);
    armRevert(t);

    t.writeLock.held = false;
    t.wiring.prepareDispose();
    t.wiring.rescueOnDispose();
    await flush();

    expect(t.showErrors.length).toBe(1);
    expect(t.dispatched).toEqual([]); // dispose path never reseeds
  });

  it("skips loudly (no rescue) when rescueOnDispose is called WITHOUT prepareDispose (call-order guard)", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    armRevert(t);

    // Contract violation: rescueOnDispose without a preceding prepareDispose. The
    // guard must skip (untrustworthy snapshot) and log — never silently rescue.
    t.wiring.rescueOnDispose();
    await flush();

    expect(applySpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe("createRevertRescueWiring — coalescing branch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dispatches IMMEDIATELY (no coalesce) when the write-lock is held", () => {
    const t = wire();
    t.doc.version = 7;
    t.writeLock.held = true;
    t.fireDocChange();
    // Lock-held → immediate dispatch of the live version, no debounce.
    expect(t.dispatched).toEqual([7]);
  });

  it("coalesces a lock-free change into a TRAILING dispatch that reads the LIVE version", () => {
    vi.useFakeTimers();
    const t = wire();
    t.doc.version = 7;
    t.writeLock.held = false;
    t.fireDocChange();
    // Scheduled on the debounce — nothing synchronous yet.
    expect(t.dispatched).toEqual([]);
    // A later external edit bumps the version before the timer fires; the fire
    // thunk reads document.version LIVE, so the trailing dispatch carries 9 not 7.
    // (A no-op schedule() would leave `dispatched` empty and fail this — the
    // non-vacuity pin for the coalescing path.)
    t.doc.version = 9;
    vi.advanceTimersByTime(100);
    expect(t.dispatched).toEqual([9]);
  });

  it("a lock-held change CANCELS a pending coalesced timer (no double dispatch)", () => {
    vi.useFakeTimers();
    const t = wire();
    t.doc.version = 5;
    t.writeLock.held = false;
    t.fireDocChange(); // schedules a trailing dispatch
    // Now an apply starts (lock held) and its change event arrives: immediate
    // dispatch + cancel the pending timer.
    t.writeLock.held = true;
    t.doc.version = 6;
    t.fireDocChange();
    expect(t.dispatched).toEqual([6]);
    // The cancelled timer must NOT fire a second (stale) dispatch.
    vi.advanceTimersByTime(100);
    expect(t.dispatched).toEqual([6]);
  });

  it("a positive alive rescue CANCELS a pending coalesced disk repost", () => {
    vi.useFakeTimers();
    const t = wire();
    t.doc.text = "DIRTY";
    t.doc.isDirty = true;
    t.fireDocChange();
    t.doc.text = "DISK";
    t.doc.isDirty = false;
    t.fireDocChange(); // arms revert + schedules trailing dispatch
    const before = t.dispatched.length;
    t.fireTabClose(); // pairs → rescue → cancel()
    vi.advanceTimersByTime(100);
    expect(t.dispatched.length).toBe(before); // cancelled timer must NOT fire a stale disk repost
  });

  it("a trailing dispatch scheduled before dispose does NOT fire after dispose", () => {
    vi.useFakeTimers();
    const t = wire();
    t.writeLock.held = false;
    t.fireDocChange(); // schedules trailing dispatch
    t.disposedFlag.value = true; // panel disposed before the timer fires
    vi.advanceTimersByTime(100);
    expect(t.dispatched).toEqual([]);
  });
});

describe("createRevertRescueWiring — alive tab-close rescue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores when a close pairs with an armed revert (revert-first) — applied is silent", async () => {
    const t = wire();
    // A clean apply LANDS the restored bytes (post-apply verify → applied).
    const applySpy = vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.text = "DIRTY";
      return true;
    });
    armRevert(t); // pendingRevert armed (restore = "DIRTY")
    t.fireTabClose(); // close pairs → rescue
    await flush();

    expect(applySpy).toHaveBeenCalledOnce();
    // applied → silent: no toast, no divergence resync.
    expect(t.showErrors).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it("restores when the close arrives BEFORE the revert (close-first ordering)", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.text = "DIRTY";
      return true;
    });

    // Close-first: the tab closes, then the revert change event lands. This pins
    // that onDocumentChange ALSO calls maybeRescueAliveRevert (a regression that
    // forgot that call would leave this red).
    t.doc.text = "DIRTY";
    t.doc.isDirty = true;
    t.fireDocChange();
    t.fireTabClose(); // lastCloseAt armed; pendingRevert not yet → no rescue here
    t.doc.text = "DISK";
    t.doc.isDirty = false;
    t.fireDocChange(); // revert arms pendingRevert → maybeRescueAliveRevert pairs → rescue
    await flush();

    expect(applySpy).toHaveBeenCalledOnce();
  });

  // S6 (finding #8): the restore's applyEdit resolved true, but the document
  // ended up holding OTHER bytes (a racing successor edit landed between the RPC
  // settling and the `.then`, OR a stale-offset splice). This is a DIVERGENCE,
  // not a failure — converge via a resync at the outcome's settled version, and
  // do NOT toast (a divergence with an ok apply must not read as "save failed").
  it("alive rescue DIVERGED (applyEdit ok but the document holds other bytes) → resync at the SETTLED version, NO toast", async () => {
    const t = wire();
    t.doc.version = 7; // pre-apply version
    // apply resolves true and ADVANCES the version to 8, but does NOT land the
    // intended "DIRTY" bytes (doc.text stays "DISK") → post-apply verify reports
    // diverged. The resync must carry the SETTLED (post-apply) version 8, read
    // inside the executor at verify time — mapping from `outcome.settledVersion`,
    // NOT a stale pre-apply read (7) nor a re-read.
    vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.version = 8;
      return true;
    });
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors).toEqual([]); // diverged is not a save failure
    expect(t.dispatched).toContain(8); // converge via resync at the settled version
    expect(t.dispatched).not.toContain(7); // never the pre-apply version
  });

  it("on restore FAILURE (applyEdit resolves false) shows an error AND reseeds via onFailure", async () => {
    const t = wire();
    vi.spyOn(workspace, "applyEdit").mockResolvedValue(false);
    t.doc.version = 42;
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors.length).toBe(1);
    // onFailure reseeds the webview to the real doc via a documentChanged dispatch.
    expect(t.dispatched).toContain(42);
  });

  it("on restore REJECTION (applyEdit throws) shows an error", async () => {
    const t = wire();
    vi.spyOn(workspace, "applyEdit").mockRejectedValue(new Error("boom"));
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors.length).toBe(1);
    expect(t.showErrors[0]).toContain("boom");
  });

  it("skips the alive rescue when already disposed", async () => {
    const t = wire();
    const applySpy = vi.spyOn(workspace, "applyEdit");
    armRevert(t);
    t.disposedFlag.value = true;
    t.fireTabClose(); // would pair, but disposed → no-op
    await flush();

    expect(applySpy).not.toHaveBeenCalled();
  });

  it("alive-path restore failure does NOT reseed if disposed before settle", async () => {
    const t = wire();
    vi.spyOn(workspace, "applyEdit").mockResolvedValue(false);
    t.doc.version = 42;
    armRevert(t);
    t.fireTabClose(); // rescue fires; apply will resolve false
    t.disposedFlag.value = true; // disposed before the promise settles
    await flush();

    expect(t.showErrors.length).toBe(1); // toast still fires
    expect(t.dispatched).not.toContain(42); // but reseed is suppressed
  });
});
