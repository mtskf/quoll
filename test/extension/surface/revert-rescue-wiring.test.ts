import { afterEach, describe, expect, it, vi } from "vitest";
import { workspace } from "vscode";

import { createRevertRescueWiring } from "../../../src/extension/surface/revert-rescue-wiring.js";

// Flush the microtask queue so the fire-and-forget `void workspace.applyEdit(...)`
// promise settles before assertions.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A minimal fake TextDocument: getText returns the current mutable buffer, version
// is a settable counter, positionAt returns a stub position (offsets are not
// asserted — the WorkspaceEdit build is exercised by e2e). isDirty is settable.
// `getTextThrows` models the document tearing down mid-restore (the dispose-time
// rescue's real hazard): every subsequent read — including the executor's
// settle-time canonical read — throws. Since `settle()` became total that no
// longer rejects the pipeline; it resolves as an UNVERIFIED restore instead.
// Two narrower breakages exist so the remaining seams can be driven apart:
//   `versionThrows` — ONLY the `version` getter dies (hence the getter/private
//                     field pair), so the content read still verifies and the tag
//                     stays `applied`/`diverged` with an unobserved version.
//   `eolThrows`     — the `eol` getter throws, breaking `canonicalizeText(text,
//                     document.eol)` in the executor's SYNCHRONOUS prefix. That is
//                     the arm's only remaining rejection source, so it is what
//                     keeps the `.catch` non-vacuous. Set it to an `Error` to
//                     control the thrown value, or `true` for a default one.
function makeDoc() {
  return {
    text: "DISK",
    _version: 1,
    isDirty: false,
    getTextThrows: false,
    versionThrows: false,
    eolThrows: false as boolean | Error,
    uri: { scheme: "file", toString: () => "file:///doc.md" },
    get version(): number {
      if (this.versionThrows) {
        throw new Error("version is gone");
      }
      return this._version;
    },
    set version(v: number) {
      this._version = v;
    },
    get eol(): number {
      if (this.eolThrows) {
        throw this.eolThrows instanceof Error ? this.eolThrows : new Error("eol is gone");
      }
      return 1;
    },
    getText(): string {
      if (this.getTextThrows) {
        throw new Error("document is gone");
      }
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
  /** Make the injected showError throw AFTER recording (models a window API that
   *  fails while the host tears down) — used to pin that each settlement dep is
   *  guarded individually, so a throwing toast never swallows the reseed. */
  showErrorThrows: { value: boolean };
  /** Make the injected dispatchDocumentChanged throw AFTER recording (models a
   *  reducer dispatch that fails while the host tears down) — used to pin that
   *  BOTH the diverged-arm dispatch and a throwing onFailure closure (which
   *  itself calls dispatchDocumentChanged) stay individually guarded, same
   *  pattern as showErrorThrows above. */
  dispatchThrows: { value: boolean };
};

function wire(): Wired {
  const doc = makeDoc();
  const writeLock = { held: false };
  const disposedFlag = { value: false };
  const survivingFlag = { value: true };
  const dispatched: number[] = [];
  const showErrors: string[] = [];
  const showErrorThrows = { value: false };
  const dispatchThrows = { value: false };
  let onDocChange: (() => void) | null = null;
  let onTabClose: (() => void) | null = null;

  const wiring = createRevertRescueWiring({
    document: doc as never,
    isDisposed: () => disposedFlag.value,
    isWriteLockHeld: () => writeLock.held,
    canWrite: () => true,
    hasSurvivingEditor: () => survivingFlag.value,
    dispatchDocumentChanged: (v) => {
      dispatched.push(v);
      if (dispatchThrows.value) {
        throw new Error("dispatch failed");
      }
    },
    showError: (m) => {
      showErrors.push(m);
      if (showErrorThrows.value) {
        throw new Error("toast failed");
      }
    },
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
    showErrorThrows,
    dispatchThrows,
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

// Mock applyEdit so the RPC resolves OK but the document dies while it is in
// flight: every later read — including the executor's settle-time canonical read
// — throws. The apply has already LANDED by then, so this is a missing
// VERIFICATION, not a failed restore: the pipeline resolves `appliedUnverified`.
// The shared arrangement for the unverified-restore tests.
function mockApplyThenKillDocument(t: Wired): void {
  vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
    t.doc.getTextThrows = true;
    return true;
  });
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

  // S6 (finding #8) review residual, PR #264: on the DISPOSE path a restore whose
  // applyEdit resolved true but whose landed bytes DIVERGE (a legitimate successor
  // edit won the apply→settle race, OR a stale-offset splice) is a RECORDED
  // DECISION, not a residual — log-only, NO toast, NO resync. The bytes landed in
  // a surviving, on-screen, undoable editor (decideOnDispose gated on
  // hasSurvivingEditor), so this is not the silent-loss the failure family is, and
  // a signal is deliberately declined to avoid false-alarming legitimate successor
  // typing (there is no webview left to converge). This pins that stance.
  it("dispose-path DIVERGED (applyEdit ok, doc holds other bytes) stays log-only — warns, NO toast, NO resync", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.doc.version = 7; // pre-apply version
    // apply resolves true and ADVANCES the version to 8 but does NOT land the
    // intended "DIRTY" bytes (doc.text stays "DISK") → post-apply verify reports
    // diverged.
    vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.version = 8;
      return true;
    });
    armRevert(t);

    t.writeLock.held = false;
    t.wiring.prepareDispose();
    // Real ordering: the panel's `disposed` flag flips true BEFORE rescueOnDispose
    // runs (quoll-editor-panel onDidDispose), so the diverged branch sees isDisposed.
    t.disposedFlag.value = true;
    t.wiring.rescueOnDispose();
    await flush();

    expect(warnSpy).toHaveBeenCalledOnce(); // diverged log fired
    expect(t.showErrors).toEqual([]); // NO toast — an ok apply is not "save failed"
    expect(t.dispatched).toEqual([]); // NO resync — disposed, no webview to converge
  });

  // The dispose-time rescue runs while the document is tearing down, so the
  // executor's settle-time reads can throw. The apply has already LANDED by then,
  // so this is a missing VERIFICATION and must NOT be reported as a failed
  // restore — but it must not be silent either.
  it("dispose-path settle-time THROW is an UNVERIFIED restore: warns, NO toast", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockApplyThenKillDocument(t);
    armRevert(t);

    t.writeLock.held = false;
    t.wiring.prepareDispose();
    t.disposedFlag.value = true;
    t.wiring.rescueOnDispose();
    await flush();

    expect(warnSpy).toHaveBeenCalled(); // visible for triage
    expect(t.showErrors).toEqual([]); // the restore LANDED — not a failure
    expect(t.dispatched).toEqual([]); // dispose path never reseeds (no onFailure)
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

  // The diverged arm wraps its dispatchDocumentChanged call in runGuarded
  // specifically so a throwing reducer dispatch cannot fall through to the
  // shared `.catch`, which would fire a spurious "could not restore" toast for
  // an apply that DID land (contradicting the log-only diverged decision). This
  // pins that guard: without it, the throw escapes the diverged case, the `.then`
  // handler rejects, and the `.catch` toasts a failure for a successful apply.
  it("alive DIVERGED whose dispatch THROWS stays log-only — no toast, no unhandled rejection (guard pins)", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    t.doc.version = 7;
    t.dispatchThrows.value = true; // the reducer dispatch itself throws
    vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.version = 8;
      return true;
    });
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(warnSpy).toHaveBeenCalledOnce(); // diverged log still fired
    expect(errSpy).toHaveBeenCalled(); // the dispatch throw was logged by runGuarded
    expect(t.showErrors).toEqual([]); // MUST NOT fall through to the .catch toast
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

  // reportRestoreFailure guards onFailure individually (runGuarded("onFailure",
  // onFailure)) so a throwing onFailure — the alive-path closure re-enters the
  // reducer via dispatchDocumentChanged, which can itself throw — cannot escape
  // into the chained `.catch`, which would re-invoke reportRestoreFailure a
  // second time (a duplicate/garbled toast) with no further catch on that second
  // call. This pins that guard: without it, showErrors would grow to 2.
  it("a THROWING onFailure does not duplicate the toast or escape as an unhandled rejection", async () => {
    const t = wire();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(workspace, "applyEdit").mockResolvedValue(false); // applyRefused → failure family
    armRevert(t);
    // fireTabClose's onFailure closure calls deps.dispatchDocumentChanged — make
    // THAT throw so onFailure itself throws.
    t.dispatchThrows.value = true;
    t.fireTabClose();
    await flush();

    expect(t.showErrors.length).toBe(1); // NOT duplicated by a second reportRestoreFailure pass
    expect(errSpy).toHaveBeenCalled(); // the onFailure throw was logged by runGuarded, not rethrown
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

  // A document torn down while the applyEdit RPC is in flight breaks the
  // settle-time reads AFTER the restore has landed. That is an UNVERIFIED restore,
  // not a failed one: no toast, no `onFailure` reseed — the bytes are in the live
  // editor and the restore's own change event reposts them.
  it("on a settle-time THROW the alive path treats it as UNVERIFIED: no toast, no onFailure", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.doc.version = 42;
    mockApplyThenKillDocument(t);
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(warnSpy).toHaveBeenCalled(); // visible for triage, not swallowed
    expect(t.showErrors).toEqual([]);
    expect(t.dispatched).toEqual([]); // no resync of our own
  });

  it("a THROWING showError in the rejection arm still lets onFailure reseed (deps guarded individually)", async () => {
    // Re-arranged over a GENUINE failure (applyEdit resolves false): the
    // individual-guard property is real, but a settle-read failure no longer
    // reaches the failure family, so it would no longer toast at all.
    const t = wire();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.doc.version = 42;
    t.showErrorThrows.value = true; // the toast itself fails
    vi.spyOn(workspace, "applyEdit").mockResolvedValue(false);
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors.length).toBe(1); // the toast was attempted
    expect(t.dispatched).toContain(42); // and its throw did NOT swallow the reseed
  });

  // The pipeline's `.catch` arm is now reachable ONLY from the executor's
  // synchronous prefix (`readText` / `canonicalize`) — the settle-time reads are
  // individually guarded and can no longer reject. Without this pin the arm's
  // guards go untested and vacuous. `eolThrows` breaks
  // `canonicalizeText(text, document.eol)` in that prefix, which precedes the
  // apply — so the restore genuinely did not land and the failure family applies.
  it("the pipeline's rejection arm still toasts and reseeds (synchronous-prefix throw)", async () => {
    const t = wire();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    armRevert(t);
    t.doc.version = 42;
    t.doc.eolThrows = true;
    t.fireTabClose();
    await flush();

    expect(errSpy).toHaveBeenCalled(); // the rejection is logged, not swallowed
    expect(t.showErrors.length).toBe(1);
    expect(t.dispatched).toContain(42); // alive path still reseeds
  });

  // The remaining nullable combination on this path: the content read WORKED (so
  // the compare says diverged) while the version getter died — leaving nothing to
  // resync TO. Log, do not dispatch; a fabricated version would be posted as an
  // authoritative document label.
  it("diverged with an UNOBSERVED version logs but dispatches no resync", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.text = "SOMETHING ELSE"; // != the restore content → diverged
      t.doc.versionThrows = true;
      return true;
    });
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.dispatched).toEqual([]); // no version → nothing to resync to
    expect(t.showErrors).toEqual([]); // a divergence with an ok apply is not a failure
    expect(warnSpy).toHaveBeenCalled();
  });

  // A VERSION-only read failure keeps the tag `applied` (the CONTENT was
  // verified), so a tag-keyed warn would be silent here while the reducer path
  // logs it. Still a silent SUCCESS for the user — but visible for triage.
  it("a VERSION-only read failure warns on the rescue path too (symmetry with the reducer path)", async () => {
    const t = wire();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(workspace, "applyEdit").mockImplementation(async () => {
      t.doc.text = "DIRTY"; // the restore LANDS → the content compare says applied
      t.doc.versionThrows = true; // only the version getter dies; getText still works
      return true;
    });
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors).toEqual([]);
    expect(t.dispatched).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("post-apply verification read failed"),
      expect.anything()
    );
  });

  // The `.catch` arm's own stringification must be TOTAL: if describing the
  // failure throws, the restore's only user-visible signal disappears — on the
  // path whose whole job is to be the last line of defence.
  it("a hostile Error.message in the rejection arm still toasts and reseeds", async () => {
    const t = wire();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = new Error("prefix boom");
    Object.defineProperty(hostile, "message", {
      get: () => ({
        toString() {
          throw new Error("message boom");
        },
      }),
    });
    t.doc.eolThrows = hostile;
    t.doc.version = 42;
    armRevert(t);
    t.fireTabClose();
    await flush();

    expect(t.showErrors.length).toBe(1); // the toast survived
    expect(t.dispatched).toContain(42); // and so did the reseed
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
