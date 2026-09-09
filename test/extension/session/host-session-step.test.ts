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
  type HostSessionEffect,
  type HostSessionEvent,
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
  // false, but no other test in this suite drives a `disposed` event through
  // `step` — so a mutation that moved `disposed` into the same rescue arm as
  // `applyEditSettled` passed the whole suite unnoticed. `disposed` needs no
  // rescue of its own here: see `releasesWriteLockOnCommit`'s doc for why the
  // drop, if any, rides a LATER, independent `applyEditSettled` step instead.
  it("does not attempt the rescue when a disposed transition throws", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("teardown bug");
      },
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
  // lock (`pendingApplyBaseVersion`) stays HELD with no second settlement ever
  // coming — the deferred side channels were neither dropped nor drained, and
  // their at-receipt guards (the Codex single-flight) never released.
  it("drops the deferred side channels when an applyEditSettled transition throws", () => {
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      // Still locked, and STAYS locked: the throw unwound before the panel
      // assigned the state the transition would have returned.
      isLocked: () => true,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);

    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      runEffects: () => {},
      settleEditBarrier: (applied) => barrier.settle(applied),
    });

    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();

    barrier.settle(true); // nothing left to resurrect
    expect(ran).not.toHaveBeenCalled();
  });

  // `settle(false)`, not `settle(true)`: the state was never committed, so the
  // lock still reads HELD and a `true` verdict would take the barrier's WAIT arm
  // and strand the thunks exactly as before. This pins the verdict itself, so a
  // rescue that passes `true` goes red even where the drop is unobservable.
  it("rescues an applyEditSettled transition throw with the FAILED verdict", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
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
  it("does not run the effects when the transition throws", () => {
    const runEffects = vi.fn();
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      runEffects,
      settleEditBarrier: () => {},
    });
    expect(() => step(settled({ kind: "ok" }, 3))).toThrow("reducer bug");
    expect(runEffects).not.toHaveBeenCalled();
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
      runEffects: () => {
        throw effectErr;
      },
      settleEditBarrier: () => {
        throw settleErr;
      },
      // no onSettleError — this is the panel's wiring
    });
    expect(() => step(themeChanged)).toThrow(effectErr);
    expect(spy).toHaveBeenCalledWith("[quoll] edit-settled barrier threw", settleErr);
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
    expect(panel).toContain("createDrainingDispatcher<HostSessionEvent>(step)");
  });
});
