// @vitest-environment node
//
// The panel's `step` is the edit-settled barrier's SOLE release site, and it
// used to settle only if `runEffects` returned normally. A throwing effect
// therefore left a deferred side-channel thunk (context-handoff /
// codex-context-handoff / switch-to-text) neither DROPPED per the barrier's
// failed-apply contract nor DRAINED — it survived and ran at the NEXT settle,
// against a document that edit never landed in. `createHostSessionStep` makes
// the settle unconditional; this file pins that, the applied/failed verdict it
// carries, and the exception ordering that keeps the effect error visible.
//
// ⚠️ `test/extension/session/` is in NO tsconfig, so vitest transpiles it
// without type-checking — every assertion here must be BEHAVIOURAL. The
// exhaustiveness guard over `ApplyEditOutcome` is compile-time and lives in
// src/, where `tsc -p ./` does check it.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createEditSettledBarrier } from "../../../src/extension/session/edit-settled-barrier.js";
import {
  type ApplyEditOutcome,
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEffect,
  type HostSessionEvent,
  isWriteLockHeld,
} from "../../../src/extension/session/host-session-core.js";
import {
  createHostSessionStep,
  isEditApplied,
} from "../../../src/extension/session/host-session-step.js";

// The executor's real settlement event, minus the optional `divergedAfterApply`.
const settled = (
  outcome: ApplyEditOutcome,
  settledVersion: number | null = null
): HostSessionEvent => ({
  type: "applyEditSettled",
  outcome,
  settledVersion,
  canWrite: true,
  currentContent: null,
  preApplyContent: "",
});
const themeChanged: HostSessionEvent = { type: "themeChanged", themeKind: "dark" };

const harness = (opts: { effects?: () => void; settle?: () => void } = {}) => {
  const order: string[] = [];
  const settles: boolean[] = [];
  const settleErrors: unknown[] = [];
  const step = createHostSessionStep({
    commitTransition: () => {
      order.push("commit");
      return [] as readonly HostSessionEffect[];
    },
    commitWriteLockRecovery: () => [],
    runEffects: () => {
      order.push("effects");
      opts.effects?.();
    },
    settleEditBarrier: (applied) => {
      order.push("settle");
      settles.push(applied);
      opts.settle?.();
    },
    onSettleError: (err) => settleErrors.push(err),
  });
  return { step, order, settles, settleErrors };
};

describe("createHostSessionStep", () => {
  it("commits, runs the effects, then settles the barrier", () => {
    const h = harness();
    h.step(themeChanged);
    expect(h.order).toEqual(["commit", "effects", "settle"]);
    expect(h.settles).toEqual([true]);
  });

  it("settles the barrier as FAILED when a failed settlement's effects throw", () => {
    const boom = new Error("effect threw");
    const h = harness({
      effects: () => {
        throw boom;
      },
    });
    expect(() => h.step(settled({ kind: "rejected", message: "x" }))).toThrow(boom);
    expect(h.settles).toEqual([false]);
    expect(h.order).toEqual(["commit", "effects", "settle"]);
  });

  it("settles the barrier as APPLIED when a successful settlement's effects throw", () => {
    const boom = new Error("ack reseed threw");
    const h = harness({
      effects: () => {
        throw boom;
      },
    });
    expect(() => h.step(settled({ kind: "ok" }, 3))).toThrow(boom);
    expect(h.settles).toEqual([true]);
  });

  it("treats an UNVERIFIED landing as applied", () => {
    expect(isEditApplied(settled({ kind: "ok" }))).toBe(true);
  });

  it("treats every non-ok outcome as NOT applied", () => {
    const nonOk: ApplyEditOutcome[] = [
      { kind: "refused" },
      { kind: "constructThrew", message: "x" },
      { kind: "applyThrew", message: "x" },
      { kind: "rejected", message: "x" },
    ];
    for (const outcome of nonOk) {
      expect(isEditApplied(settled(outcome))).toBe(false);
    }
  });

  // The outer `switch`'s default arm is unreachable by type — `HostSessionEvent`
  // is a closed union — so we cast past the type system to exercise it, the same
  // move as the reducer exhaustiveness guard in test/webview/state.test.ts. The
  // previous implementation was an early `if (event.type !== "applyEditSettled")
  // { return true; }`, which answered an unknown member with the DRAIN verdict;
  // reverting to it turns this test red, which is what makes the switch a real
  // behavioural change and not a reformat. The other half — a NEW union member
  // failing to compile — is checked by a different oracle (`tsc`, via the
  // `never` assignment), and cannot be pinned here.
  it("treats an UNKNOWN event type as NOT applied, and says so", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = { type: "no-such-event" } as unknown as HostSessionEvent;
    try {
      expect(isEditApplied(unknown)).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        "[quoll] unhandled HostSessionEvent for the barrier verdict; treating the edit as NOT applied",
        unknown
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not settle when a NON-settlement transition throws", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
    });
    expect(() => step(themeChanged)).toThrow("reducer bug");
    expect(settles).toEqual([]);
  });

  // The rescue condition is its own exhaustive switch (`releasesWriteLockOnCommit`,
  // not exported), same idiom as `isEditApplied`'s outer switch and the same
  // reason: an unknown event must answer explicitly rather than silently
  // skipping the rescue, which would reintroduce the stranding this module
  // exists to fix. As with `isEditApplied`'s own unknown-event test, the real
  // guard is `tsc`'s `never` assignment (a NEW union member fails compilation);
  // this only pins the runtime default arm's own behaviour.
  it("does not attempt the rescue for an UNKNOWN event type, and says so", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
    });
    const unknown = { type: "no-such-event" } as unknown as HostSessionEvent;
    try {
      expect(() => step(unknown)).toThrow("reducer bug");
      expect(settles).toEqual([]);
      expect(spy).toHaveBeenCalledWith(
        "[quoll] unhandled HostSessionEvent while deciding whether a transition throw needs the write-lock rescue",
        unknown
      );
    } finally {
      spy.mockRestore();
    }
  });

  // Mutation coverage: `releasesWriteLockOnCommit`'s `disposed` case answers
  // `null`, but no other test in this suite drives a `disposed` event through
  // `step` — so a mutation that moved `disposed` into the same rescue arm as
  // `applyEditSettled` passed the whole suite unnoticed. (Since that helper
  // returns the SETTLEMENT rather than a boolean, tsc now rejects such a move
  // outright; this test still covers the runtime behaviour.) `disposed` needs no
  // rescue of its own here: see `releasesWriteLockOnCommit`'s doc for why the
  // drop, if any, rides a LATER, independent `applyEditSettled` step instead.
  // The half PR #406 did not pay: the rescue released the deferred side
  // channels' at-receipt guards but never the lock itself, so the payment was
  // one-shot — a retried side channel re-deferred behind a lock nothing would
  // ever release.
  it("commits the write-lock recovery when an applyEditSettled transition throws — BEFORE the barrier settle", () => {
    const order: string[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        order.push("commit");
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => {
        order.push("recover");
        return [{ type: "logWarn", message: "m", detail: {} }] as readonly HostSessionEffect[];
      },
      runEffects: () => order.push("effects"),
      settleEditBarrier: () => order.push("settle"),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(order).toEqual(["commit", "recover", "effects", "settle"]);
  });

  // The label the recovery re-bases on is the THROWING SETTLEMENT's own
  // observed version, passed through — not a fresh read. Pins the pass-through
  // (both a value and the unobserved `null`), which is what keeps the recovery
  // free of a second guarded version reader.
  it("passes the throwing settlement's settledVersion through to the recovery", () => {
    const seen: (number | null)[] = [];
    const mk = () =>
      createHostSessionStep({
        commitTransition: () => {
          throw new Error("reducer bug");
        },
        commitWriteLockRecovery: (settledVersion) => {
          seen.push(settledVersion);
          return [];
        },
        runEffects: () => {},
        settleEditBarrier: () => {},
      });
    expect(() => mk()(settled({ kind: "ok" }, 7))).toThrow("reducer bug");
    expect(() => mk()(settled({ kind: "ok" }, null))).toThrow("reducer bug");
    expect(seen).toEqual([7, null]);
  });

  it("does NOT attempt the write-lock recovery when a NON-settlement transition throws", () => {
    const recovered = vi.fn(() => [] as readonly HostSessionEffect[]);
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: recovered,
      runEffects: () => {},
      settleEditBarrier: () => {},
    });
    expect(() => step(themeChanged)).toThrow("reducer bug");
    expect(recovered).not.toHaveBeenCalled();
  });

  // LEARNING 2026-09-09: an exhaustive switch only catches a MISSING member,
  // never one placed in the wrong arm — so the `null` side of
  // `releasesWriteLockOnCommit` needs its own behavioural pin. Moving
  // `settlementTransitionFailed` into the arm that RETURNS THE EVENT would make a
  // throwing recovery recover itself. For THIS member tsc now helps: since the
  // helper returns `SettlementEvent | null`, the move is a `TS2322` ("missing the
  // following properties … outcome, canWrite, currentContent, preApplyContent") —
  // measured. The general hazard stands, though, since a member that happens to
  // be structurally compatible would still slip through, which is why the runtime
  // pin stays. The console.error spy is what makes it non-vacuous: the DEFAULT
  // arm also answers `null`, and logs — so asserting only "no recovery" would
  // pass for a member that fell through to the default instead.
  it("does NOT recover a throwing RECOVERY transition (no rescue of the rescue)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recovered = vi.fn(() => [] as readonly HostSessionEffect[]);
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: recovered,
      runEffects: () => {},
      settleEditBarrier: () => {},
    });
    expect(() => step({ type: "settlementTransitionFailed", settledVersion: 3 })).toThrow(
      "reducer bug"
    );
    expect(recovered).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps the transition error when the recovery COMMIT throws, and still DROPS the side channels", () => {
    const reported: unknown[] = [];
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => {
        throw new Error("recovery threw");
      },
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
      onSettleError: (err) => reported.push(err),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect((reported[0] as Error).message).toBe("recovery threw");
    // A FAILING recovery must not cost the side-channel DROP — that release is
    // the half PR #406 already paid for, and it is independent of whether the
    // lock got freed: the barrier's `settle` reaches its drop arm on
    // `isDisposed() || !applied` BEFORE it ever consults `isLocked()`. Without
    // this assertion the two failures compound — gating the rescue on the
    // recovery's success left all 335 `test/extension/session` tests green
    // while re-stranding the deferred thunks' at-receipt guards.
    expect(settles).toEqual([false]);
  });

  it("keeps the transition error when the recovery EFFECTS throw, and still settles the barrier", () => {
    const reported: unknown[] = [];
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () =>
        [{ type: "showResyncFailure" }] as readonly HostSessionEffect[],
      runEffects: () => {
        throw new Error("recovery effect threw");
      },
      settleEditBarrier: (applied) => settles.push(applied),
      onSettleError: (err) => reported.push(err),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect((reported[0] as Error).message).toBe("recovery effect threw");
    expect(settles).toEqual([false]);
  });

  // Same non-vacuity reasoning as the "no rescue of the rescue" test above.
  it("treats the recovery event itself as NOT applied, from an explicit arm", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isEditApplied({ type: "settlementTransitionFailed", settledVersion: 3 })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("does not attempt the rescue when a disposed transition throws", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("teardown bug");
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
    });
    const disposed: HostSessionEvent = { type: "disposed" };
    expect(() => step(disposed)).toThrow("teardown bug");
    expect(settles).toEqual([]);
  });

  // The two-step claim from this module's header / `releasesWriteLockOnCommit`'s
  // doc, chained through a REAL barrier for the first time: a throwing
  // `disposed` transition needs no rescue of its own, because the in-flight
  // apply's OWN, later, independent `applyEditSettled` step still arrives and
  // its `settleEditBarrier` call finds `isDisposed()` already true — so the
  // drop is real, it just rides that later step. `edit-settled-barrier.test.ts`
  // pins the barrier's `isDisposed`-drop in isolation, and the test right above
  // pins only that the `disposed` step itself skips the rescue (a stub
  // `settleEditBarrier`, no real barrier, no follow-up step); neither chains
  // both steps through one real barrier or checks the MID-state in between.
  it("drops a deferred side channel via the real barrier when the in-flight apply's own settlement arrives after a disposed transition throws", () => {
    let locked = true;
    let panelDisposed = false;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => panelDisposed,
      onError: () => {},
    });
    barrier.run(ran, dropped); // deferred: still locked

    const step = createHostSessionStep({
      commitTransition: (event) => {
        if (event.type === "disposed") {
          throw new Error("teardown bug");
        }
        locked = false; // the in-flight apply's own settlement releases the lock
        return [];
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => barrier.settle(applied),
    });

    // Flips BEFORE the throwing step, mirroring `quoll-editor-panel.ts`'s
    // `onDidDispose`, which sets the panel's local `disposed` flag before
    // dispatching the `disposed` event — so `isDisposed()` already reads true
    // by the time any later settlement checks it.
    panelDisposed = true;
    expect(() => step({ type: "disposed" })).toThrow("teardown bug");
    // Mid-state: the throwing `disposed` step itself drops/runs nothing.
    expect(dropped).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();

    step(settled({ kind: "ok" }, 3)); // the apply's own settlement, arriving later
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();
  });

  // The rescue's OTHER direction, and the reason it cannot be an unconditional
  // `settle(false)`: this throw did not happen on the settlement, so the write
  // lock is still held by an apply whose OWN settlement is still coming — and
  // that settlement will legitimately DRAIN these thunks. Dropping them here
  // would destroy work the barrier promised to run.
  it("leaves deferred side channels for the real settlement when a NON-settlement transition throws", () => {
    let locked = true;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);

    const step = createHostSessionStep({
      commitTransition: (event) => {
        if (event.type === "themeChanged") {
          throw new Error("reducer bug");
        }
        locked = false; // the real settlement releases the write lock
        return [];
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => barrier.settle(applied),
    });

    expect(() => step(themeChanged)).toThrow("reducer bug");
    expect(dropped).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();

    step(settled({ kind: "ok" }, 3)); // the apply's own settlement still arrives
    expect(ran).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  // The stranding this module used to accept: an `applyEditSettled` transition
  // that throws unwinds BEFORE the panel commits the new state, so the write
  // lock (`pendingApplyBaseVersion`) WOULD stay held with no second settlement
  // ever coming — the deferred side channels neither dropped nor drained, their
  // at-receipt guards (the Codex single-flight) never released. Both halves are
  // paid now (the recovery releases the lock, this drop releases the guards);
  // this test isolates the DROP.
  it("drops the deferred side channels when an applyEditSettled transition throws", () => {
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      // The stub PINS the lock as held so the DROP is observable on its own:
      // in production the recovery releases it in the same catch, which the
      // real-composition test further down measures. Keep the two separate —
      // isolating the drop from the release is why this test still earns its
      // place.
      isLocked: () => true,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);

    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => barrier.settle(applied),
    });

    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();

    barrier.settle(true); // nothing left to resurrect
    expect(ran).not.toHaveBeenCalled();
  });

  // `settle(false)`, not `settle(true)`: the recovery cannot establish that the
  // edit landed (it is outcome-blind), so the thunks must be DROPPED, never
  // drained. ⚠️ Do not read the stub below as the production mechanism: the
  // `commitWriteLockRecovery: () => []` stub does NOT release the lock, so in
  // THIS test a `true` verdict would merely WAIT. In production the recovery
  // frees the lock in the same catch (see the note ~25 lines above), so `true`
  // would take the barrier's DRAIN arm and RUN the thunks — the worse failure,
  // and the one this pins against. Pinning the VERDICT rather than the drop is
  // what makes a rescue that passes `true` go red even where the drop is
  // unobservable.
  it("rescues an applyEditSettled transition throw with the FAILED verdict", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(settles).toEqual([false]);
  });

  // Same rule as the effect-throw path: the recovery must not step on the
  // failure it is recovering from. The transition error is the triage payload.
  it("keeps the transition error when the rescue settle also throws", () => {
    const transitionErr = new Error("reducer bug");
    const settleErr = new Error("settle threw");
    const reported: unknown[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw transitionErr;
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: () => {
        throw settleErr;
      },
      onSettleError: (err) => reported.push(err),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow(transitionErr);
    expect(reported).toEqual([settleErr]);
  });

  // A reporter throw cannot displace the transition error either (the DEFAULT
  // reporter is a console call, which a broken host environment breaks).
  //
  // `toThrow(transitionErr)` alone is vacuous here: it stays green even with
  // the whole rescue block deleted, since a deleted rescue still rethrows
  // `transitionErr` unmodified. The `settles` / `reported` assertions are
  // what actually pin that the rescue RAN (measured: reverting the rescue
  // block turns them red while leaving `toThrow` passing — see the PR's
  // revert-check notes).
  it("keeps the transition error when the rescue settle AND the reporter throw", () => {
    const transitionErr = new Error("reducer bug");
    const settleErr = new Error("settle threw");
    const settles: boolean[] = [];
    const reported: unknown[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw transitionErr;
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {},
      settleEditBarrier: (applied) => {
        settles.push(applied);
        throw settleErr;
      },
      onSettleError: (err) => {
        reported.push(err);
        throw new Error("reporter threw");
      },
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow(transitionErr);
    expect(settles).toEqual([false]);
    expect(reported).toEqual([settleErr]);
  });

  // The effects must NOT run when the transition threw: there is no effect list
  // (the transition never returned one) and the state they would act on was
  // never committed.
  // Was "does not run the effects when the transition throws". The recovery
  // calls the SAME `runEffects` dep, so a bare not-called assertion is no
  // longer the right pin — but the INTENT (the throwing transition's own effect
  // list never runs) still is, and a distinct recovery effect makes it stronger
  // than the original: exactly one call, carrying the recovery's list.
  it("runs the RECOVERY's effects but never the throwing transition's own", () => {
    const runEffects = vi.fn();
    const recoveryEffect = { type: "logWarn", message: "recovery", detail: {} } as const;
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      commitWriteLockRecovery: () => [recoveryEffect],
      runEffects,
      settleEditBarrier: () => {},
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(runEffects).toHaveBeenCalledTimes(1);
    expect(runEffects).toHaveBeenCalledWith([recoveryEffect]);
  });

  it("drops a deferred side channel when a failed settlement's effects throw", () => {
    let locked = true;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);
    expect(ran).not.toHaveBeenCalled();

    const step = createHostSessionStep({
      commitTransition: () => {
        locked = false; // the settlement released the write lock
        return [];
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {
        throw new Error("ack reseed threw");
      },
      settleEditBarrier: (applied) => barrier.settle(applied),
    });
    expect(() => step(settled({ kind: "rejected", message: "x" }))).toThrow();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();

    barrier.settle(true); // not resurrected by a later successful settle
    expect(ran).not.toHaveBeenCalled();
  });

  it("still drains a deferred side channel when a SUCCESSFUL settlement's effects throw", () => {
    let locked = true;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);

    const step = createHostSessionStep({
      commitTransition: () => {
        locked = false;
        return [];
      },
      commitWriteLockRecovery: () => [],
      runEffects: () => {
        throw new Error("ack reseed threw");
      },
      settleEditBarrier: (applied) => barrier.settle(applied),
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("keeps the effect error when the settle also throws", () => {
    const effectErr = new Error("effect threw");
    const settleErr = new Error("settle threw");
    const h = harness({
      effects: () => {
        throw effectErr;
      },
      settle: () => {
        throw settleErr;
      },
    });
    expect(() => h.step(themeChanged)).toThrow(effectErr);
    expect(h.settleErrors).toEqual([settleErr]);
  });

  it("propagates a settle throw when the effects did not throw", () => {
    const settleErr = new Error("settle threw");
    const h = harness({
      settle: () => {
        throw settleErr;
      },
    });
    expect(() => h.step(themeChanged)).toThrow(settleErr);
    expect(h.settleErrors).toEqual([]);
  });

  it("keeps the effect error when the settle AND the error reporter throw", () => {
    const effectErr = new Error("effect threw");
    const step = createHostSessionStep({
      commitTransition: () => [],
      commitWriteLockRecovery: () => [],
      runEffects: () => {
        throw effectErr;
      },
      settleEditBarrier: () => {
        throw new Error("settle threw");
      },
      onSettleError: () => {
        throw new Error("reporter threw");
      },
    });
    expect(() => step(themeChanged)).toThrow(effectErr);
  });

  // The panel does NOT inject `onSettleError` (see its `createHostSessionStep`
  // call), so the DEFAULT reporter is the only one production ever runs. Every
  // other test here injects one, which leaves that default unobserved — deleting
  // it was measured to keep the rest of this file green.
  it("reports a settle throw through the DEFAULT reporter when none is injected", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const effectErr = new Error("effect threw");
    const settleErr = new Error("settle threw");
    const step = createHostSessionStep({
      commitTransition: () => [],
      commitWriteLockRecovery: () => [],
      runEffects: () => {
        throw effectErr;
      },
      settleEditBarrier: () => {
        throw settleErr;
      },
      // no onSettleError — this is the panel's wiring
    });
    expect(() => step(themeChanged)).toThrow(effectErr);
    expect(spy).toHaveBeenCalledWith(
      "[quoll] edit-settled barrier or write-lock recovery threw",
      settleErr
    );
    spy.mockRestore();
  });

  // `effectsError` is BOXED on purpose. Every other test throws an `Error`, so an
  // unboxed `let effectsError: unknown = null` stays green throughout — this is
  // the only case that separates "the effects threw a falsy value" from "the
  // effects completed", and getting it wrong hands the caller the SETTLE error
  // (the recovery path masking the failure it was recovering from).
  it("keeps a FALSY effect error (throw null) when the settle also throws", () => {
    const settleErr = new Error("settle threw");
    const reported: unknown[] = [];
    const step = createHostSessionStep({
      commitTransition: () => [],
      commitWriteLockRecovery: () => [],
      runEffects: () => {
        // A non-Error throw is the whole point of this test: it is the value the
        // boxing exists for, so the rule is suppressed rather than satisfied.
        // biome-ignore lint/style/useThrowOnlyError: pins the falsy-throw contract
        throw null;
      },
      settleEditBarrier: () => {
        throw settleErr;
      },
      onSettleError: (err) => reported.push(err),
    });
    let thrown: unknown = "NOTHING THROWN";
    try {
      step(themeChanged);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(null); // the effect error, not the settle error
    expect(reported).toEqual([settleErr]);
  });

  // Also pins the dispatcher's FAILURE POLICY end-to-end (the policy itself is
  // unit-tested in host-session-core.test.ts): a re-entrant dispatch issued
  // before the throw is drained inside the SAME dispatch, so it can never be
  // replayed later against a diverged state — and every drained step still
  // settles the barrier. Until PR #405 the drain abandoned that event and the
  // next external dispatch drained it first; these assertions were the measured
  // baseline of that residue.
  it("settles through the real dispatcher and drains the throw's residue in the same dispatch", () => {
    const settles: boolean[] = [];
    const seen: string[] = [];
    let dispatch!: (event: HostSessionEvent) => void;
    let firstEffects = true;
    dispatch = createDrainingDispatcher<HostSessionEvent>(
      createHostSessionStep({
        commitTransition: (event) => {
          // Qualify the theme events by themeKind: on `event.type` alone the
          // stale re-entrant event and the new one collapse to the same string,
          // and a LIFO drain would read identical to a FIFO one.
          seen.push(event.type === "themeChanged" ? `themeChanged:${event.themeKind}` : event.type);
          return [];
        },
        commitWriteLockRecovery: () => [],
        runEffects: () => {
          if (!firstEffects) {
            return;
          }
          firstEffects = false;
          // Enqueued behind the active drain, then abandoned by the throw.
          dispatch({ type: "themeChanged", themeKind: "light" });
          throw new Error("effect threw");
        },
        settleEditBarrier: (applied) => settles.push(applied),
      })
    );
    expect(() => dispatch(settled({ kind: "refused" }))).toThrow();
    // The throw reaches the caller only AFTER the queue is empty: the settle for
    // the failed apply, then the re-entrant event's own step and settle.
    expect(seen).toEqual(["applyEditSettled", "themeChanged:light"]);
    expect(settles).toEqual([false, true]); // settled despite the throw
    dispatch(themeChanged); // the drain guard was released by the dispatcher's finally
    expect(seen).toEqual(["applyEditSettled", "themeChanged:light", "themeChanged:dark"]);
    expect(settles).toEqual([false, true, true]);
  });

  // Catches a full revert of the panel to an inline `step`; it does NOT catch a
  // hypothetical second inline step living alongside the factory. Comments are
  // stripped first so a mention in prose cannot satisfy the pin.
  it("is the panel's step composition, wired into the dispatcher", () => {
    const panel = readFileSync(
      new URL("../../../src/extension/session/quoll-editor-panel.ts", import.meta.url),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      // Trailing line comments. This also truncates any "//" inside a string,
      // which only ever removes text — it can narrow the haystack, never
      // manufacture a match, so it cannot vacate the pin.
      .replace(/^(.*?)\/\/.*$/gm, "$1");
    expect(panel).toContain('createHostSessionStep } from "./host-session-step.js"');
    expect(panel).toContain("const step = createHostSessionStep({");
    // The barrier's SOLE release site: pin that the panel really hands the
    // factory the live barrier's `settle`, not a stub. Two loose substrings
    // rather than one exact line, so reformatting cannot vacate the pin.
    expect(panel).toContain("settleEditBarrier:");
    expect(panel).toMatch(/settleEditBarrier:[\s\S]{0,80}editSettledBarrier\.settle\(/);
    // `HostSessionInputEvent`, NOT `HostSessionEvent`: the dispatcher's element
    // type EXCLUDES `settlementTransitionFailed`, which is committed from the
    // step's catch rather than queued. Pinning the narrow literal is what stops
    // a future widening back to the full union from going unnoticed.
    expect(panel).toContain("createDrainingDispatcher<HostSessionInputEvent>(step)");
  });

  // The panel's composition, end to end: real core + real step + real barrier +
  // real dispatcher, with the panel's own `state` closure. Pins BOTH halves of
  // the fix — the lock release and the stash disposition — plus the durable (no
  // longer one-shot) side-channel release.
  it("releases the lock and disposes of the stash through the real panel composition", () => {
    const core = createHostSessionCore(
      { uriString: "file:///t.md", fsPath: "/t.md" },
      {
        // Throws for the STASH content only: the drain reaches decideEdit →
        // validator and the settlement transition throws. A later edit must
        // still be able to validate, or the "next edit" assertion below could
        // never pass for the right reason.
        validateForWrite: (content: string) => {
          if (content === "edit1+x") {
            throw new Error("validator blew up");
          }
          return { ok: true } as const;
        },
        mintEpochGeneration: () => 7,
      }
    );
    // Edit #1 in flight (lock held at base 5), edit #2 stashed behind it.
    let state = {
      ...core.initialState(5),
      pendingApplyBaseVersion: 5,
      inFlightContent: "edit1",
      pendingEdit: { content: "edit1+x", baseDocVersion: 5 },
    };
    const effects: HostSessionEffect[] = [];
    const barrier = createEditSettledBarrier({
      isLocked: () => isWriteLockHeld(state),
      isDisposed: () => false,
      onError: () => {},
    });
    const commit = (event: HostSessionEvent): readonly HostSessionEffect[] => {
      const result = core.transition(state, event);
      state = result.state;
      return result.effects;
    };
    const step = createHostSessionStep({
      commitTransition: commit,
      commitWriteLockRecovery: (settledVersion) =>
        commit({ type: "settlementTransitionFailed", settledVersion }),
      runEffects: (list) => effects.push(...list),
      settleEditBarrier: (applied) => barrier.settle(applied),
    });
    const dispatch = createDrainingDispatcher<HostSessionEvent>(step);

    const deferred = vi.fn();
    const droppedGuard = vi.fn();
    barrier.run(deferred, droppedGuard); // deferred behind the held lock

    expect(() =>
      dispatch({
        type: "applyEditSettled",
        outcome: { kind: "ok" },
        settledVersion: 6,
        canWrite: true,
        currentContent: "edit1",
        preApplyContent: "seed",
      })
    ).toThrow("validator blew up");

    // 1. the lock is RELEASED (it was held for the panel's life before this fix)
    expect(isWriteLockHeld(state)).toBe(false);
    // 2. the stash is gone, the internal error reached the user (standing in for
    //    the save-failure toast the throw abandoned) WITHOUT claiming a loss the
    //    replay buffer will undo, and the webview is un-parked at the settled
    //    label so that buffer can re-post those bytes
    expect(state.pendingEdit).toBeNull();
    const toast = effects.find((e) => e.type === "showError");
    expect((toast as { message: string }).message).toContain("internal error");
    expect((toast as { message: string }).message).not.toContain("dropped");
    expect(effects.some((e) => e.type === "postDocument" && e.docVersion === 6)).toBe(true);
    // 3. the deferred side channel was dropped (guard released) …
    expect(droppedGuard).toHaveBeenCalledTimes(1);
    expect(deferred).not.toHaveBeenCalled();
    // … and the release is DURABLE: a RETRY runs immediately instead of
    // re-deferring behind a lock nothing would release.
    const retried = vi.fn();
    barrier.run(retried);
    expect(retried).toHaveBeenCalledTimes(1);
    // 4. the panel can accept and persist the NEXT edit
    effects.length = 0;
    dispatch({
      type: "edit",
      baseDocVersion: state.lastAppliedDocVersion,
      content: "next",
      documentVersion: state.lastAppliedDocVersion,
      canWrite: true,
      currentContent: "edit1",
    });
    expect(effects.some((e) => e.type === "applyEdit" && e.content === "next")).toBe(true);
  });

  // Catches a revert of the panel wiring. A source-contract pin, not an
  // executable one, for the same reason the neighbouring composition pin is:
  // this closure is vscode-bound and cannot be constructed in a unit test.
  it("is the panel's write-lock recovery wiring", () => {
    const panel = readFileSync(
      new URL("../../../src/extension/session/quoll-editor-panel.ts", import.meta.url),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^(.*?)\/\/.*$/gm, "$1");
    expect(panel).toContain("commitWriteLockRecovery:");
    // The recovery must go through the panel's own committing lambda (so the
    // release happens in the REDUCER, never by patching `state`) and carry the
    // settlement's version through.
    expect(panel).toMatch(
      /commitWriteLockRecovery:\s*\(settledVersion\)\s*=>\s*commitTransition\(\{/
    );
    // NEGATIVE pin over the recovery lambda's ACTUAL span, not a character
    // window: slice from `commitWriteLockRecovery:` to the next dep property
    // (`runEffects:`) and assert the read seams are absent inside it. The
    // `not.toBe("")` guard is what keeps the pin from going vacuous if the
    // properties are ever renamed or reordered.
    const recoveryWiring = panel.match(/commitWriteLockRecovery:([\s\S]*?)runEffects:/)?.[1] ?? "";
    expect(recoveryWiring).not.toBe("");
    expect(recoveryWiring).toContain('type: "settlementTransitionFailed"');
    expect(recoveryWiring).toContain("settledVersion");
    // The panel's `applyEditSeam.readVersion` keeps its own `document.version`
    // read — that is why the pin is scoped to this span rather than the file.
    expect(recoveryWiring).not.toContain("document.version");
    expect(recoveryWiring).not.toContain("readVersionGuarded");
  });
});
