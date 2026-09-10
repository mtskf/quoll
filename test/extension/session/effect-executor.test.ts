// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createEffectExecutor,
  type EffectExecutorDeps,
} from "../../../src/extension/session/effect-executor.js";
import type { HostToWebview } from "../../../src/shared/protocol.js";

const themeMsg: HostToWebview = { protocol: 1, type: "theme", themeKind: "dark" };

// The seam's edit type. The executor never inspects an edit — it only
// forwards the seam to `executeDocumentWrite`, which hands `build`'s output
// straight to `apply` — so an opaque marker stands in for production's
// `WorkspaceEdit`.
// ⚠️ NOT a compile-time guard: this file is in no `pnpm compile` tsc program
// and vitest is transpile-only, so this annotation documents intent only.
// The build→apply linkage is pinned in test/extension/types-equality.test.ts.
type FakeEdit = { readonly fake: "edit" };
const fakeEdit: FakeEdit = { fake: "edit" };

// Minimal deps factory — overridable per test. Unused seams throw if hit so a
// test that accidentally reaches them fails loudly instead of silently passing.
function makeDeps(over: Partial<EffectExecutorDeps<FakeEdit>> = {}): EffectExecutorDeps<FakeEdit> {
  return {
    isDisposed: () => false,
    getState: () => {
      throw new Error("getState not stubbed");
    },
    uriString: () => "file:///test.md",
    dispatch: vi.fn(),
    send: vi.fn(async () => true),
    recordEvent: vi.fn(),
    showError: vi.fn(),
    canWrite: () => true,
    buildSeedDocument: (v, externalEpoch, epochGeneration) => ({
      protocol: 1,
      type: "document",
      content: "",
      docVersion: v,
      canWrite: true,
      themeKind: "light",
      externalEpoch,
      epochGeneration,
    }),
    buildRejectedDraft: (content, v, externalEpoch, epochGeneration) => ({
      protocol: 1,
      type: "document",
      content,
      docVersion: v,
      canWrite: true,
      themeKind: "light",
      externalEpoch,
      epochGeneration,
    }),
    buildTheme: (themeKind) => ({ protocol: 1, type: "theme", themeKind }),
    buildEditRejected: (error) => ({ protocol: 1, type: "edit-rejected", error }),
    applyEditSeam: {
      readText: () => "",
      readVersion: () => 0,
      readCanonical: () => "",
      canonicalize: (text) => text,
      build: () => fakeEdit,
      apply: async () => true,
    },
    openExternal: vi.fn(),
    ...over,
  };
}

describe("effect-executor post()", () => {
  it("disposed: never calls send, never records", () => {
    const send = vi.fn(async () => true);
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ isDisposed: () => true, send, recordEvent }));
    post(themeMsg);
    expect(send).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("ok=true: records the delivered event", async () => {
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    post(themeMsg);
    resolveSend(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).toHaveBeenCalledWith(themeMsg);
  });

  it("ok=false: does NOT record", async () => {
    const send = vi.fn(async () => false);
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    post(themeMsg);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("reject: does NOT record, does not throw", async () => {
    const send = vi.fn(() => Promise.reject(new Error("detached")));
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    expect(() => post(themeMsg)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("send() synchronous throw: swallowed (no throw to caller), never records", async () => {
    const send = vi.fn(() => {
      throw new Error("sync transport throw");
    });
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    expect(() => post(themeMsg)).not.toThrow();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  // error-handler A: the .then OK-arm inner disposed guard. If the implementer
  // drops it, recordEvent fires post-dispose and this goes red.
  it("ok=true after dispose: does NOT record (inner .then disposed guard)", async () => {
    let disposed = false;
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(
      makeDeps({ isDisposed: () => disposed, send, recordEvent })
    );
    post(themeMsg);
    disposed = true;
    resolveSend(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

import type { HostSessionState } from "../../../src/extension/session/host-session-core.js";

// A state with no pending edit.
const noStash = { pendingEdit: null } as unknown as HostSessionState;

// Flush the executor's async settlement (executeDocumentWrite awaits the apply,
// then runApplyEdit's `.then` dispatches) — a handful of microtask turns.
const flushSettle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

// A verified-write seam (adapter) modelling one settlement. Defaults land
// content "new" cleanly (settled === intended → applied). readText "old" keeps
// the span non-no-op for content !== "old".
function seamFor(over: Partial<EffectExecutorDeps<FakeEdit>["applyEditSeam"]> = {}) {
  return {
    readText: () => "old",
    readVersion: () => 1,
    readCanonical: () => "new",
    canonicalize: (t: string) => t,
    build: () => fakeEdit,
    apply: async () => true,
    ...over,
  };
}

// Run one applyEdit through the wrapper and return the dispatch spy.
async function runApply(
  seamOver: Partial<EffectExecutorDeps<FakeEdit>["applyEditSeam"]> = {},
  depsOver: Partial<EffectExecutorDeps<FakeEdit>> = {},
  content = "new"
) {
  const dispatch = vi.fn();
  const { runEffects } = createEffectExecutor(
    makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seamFor(seamOver), ...depsOver })
  );
  runEffects([{ type: "applyEdit", content, baseDocVersion: 6 }]);
  await flushSettle();
  return dispatch;
}

// The wrapper is a THIN mapper over the document-write executor: the write
// pipeline itself (no-op skip, build/apply throw detection, canonical reads,
// divergence compare) is pinned in test/extension/document-write. These tests
// pin the MAPPING — tagged outcome → applyEditSettled event — and the
// dispatch-EVEN-post-dispose stash-drain safety.
describe("effect-executor runApplyEdit (wrapper mapping)", () => {
  it("applied → ok(settledVersion) + settled snapshots + divergedAfterApply false", async () => {
    const dispatch = await runApply({ readVersion: () => 8, readCanonical: () => "new" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok" },
        settledVersion: 8,
        currentContent: "new", // from the outcome's settledContent, not a re-read
        preApplyContent: "old", // canonical pre-apply, populated for ok too
        divergedAfterApply: false,
      })
    );
  });

  it("diverged (settled !== intended, apply ok) → ok + divergedAfterApply true", async () => {
    const dispatch = await runApply({ readVersion: () => 8, readCanonical: () => "CORRUPTED" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok" },
        settledVersion: 8,
        currentContent: "CORRUPTED",
        divergedAfterApply: true,
      })
    );
  });

  it("applyRefused → refused", async () => {
    const dispatch = await runApply({ apply: async () => false });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
    );
  });

  it("buildThrew → constructThrew(message)", async () => {
    const dispatch = await runApply({
      build: () => {
        throw new Error("boom-build");
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "constructThrew", message: "boom-build" }),
      })
    );
  });

  it("applyThrew (sync) → applyThrew(message)", async () => {
    const dispatch = await runApply({
      apply: () => {
        throw new Error("boom-apply");
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "applyThrew", message: "boom-apply" }),
      })
    );
  });

  it("applyRejected → rejected(message)", async () => {
    const dispatch = await runApply({ apply: () => Promise.reject(new Error("rej")) });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected", message: "rej" }),
      })
    );
  });

  it("threads the live canWrite onto the settlement event", async () => {
    const dispatch = await runApply({}, { canWrite: () => false });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", canWrite: false })
    );
  });

  // Stash-drain safety (error-handler C/D): the settlement must dispatch EVEN
  // post-dispose — for the ok arm AND the refused arm — so a one-more-char stash
  // typed during the in-flight apply can still drain after onDidDispose.
  it("ok settlement dispatches EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply({ readVersion: () => 9 }, { isDisposed: () => true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok" },
        settledVersion: 9,
      })
    );
  });

  it("refused settlement dispatches EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply({ apply: async () => false }, { isDisposed: () => true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
    );
  });

  // Settlement is the write lock's only COMPLETING release valve
  // (host-session-core clears `pendingApplyBaseVersion` on `applyEditSettled`,
  // on the `settlementTransitionFailed` recovery for a settlement whose
  // transition THREW, and on dispose — neither of the last two can stand in for
  // a settlement that resolved), so BOTH promise arms must reach `dispatch`.
  // execute-write GUARDS its two settle-time verification reads individually
  // now, so the surviving rejection source is its SYNCHRONOUS prefix
  // (`readText` / `canonicalize`) — which runs before anything can land, so a
  // rejection there really does describe a write that never happened.
  // Previously such a rejection was left unhandled by the bare
  // `void ….then(onFulfilled)` (`void` discards the promise reference, it does
  // not catch) and the lock was held for the session.
  it("pipeline rejection (synchronous-prefix read throws) STILL settles, as a non-ok outcome", async () => {
    const dispatch = await runApply({
      readText: () => {
        throw new Error("boom-read");
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected", message: "boom-read" }),
        // Nothing was read BY THE PIPELINE — the guarded dispatch retry
        // (readVersionGuarded) labelled the settlement instead, against the
        // seam's default healthy `readVersion: () => 1`. The unobserved case
        // (the retry itself fails) is pinned by the dedicated persistent-
        // failure test below.
        settledVersion: 1,
        // NOT OBSERVED — content was not read, so the settlement says so rather
        // than fabricating bytes. Safe because the outcome is non-ok (`canDrain`
        // requires `ok`, so it never reaches `decideEdit`) and because the
        // foreign-bytes check reads `null` as unobserved; foreign evidence, if
        // any, comes from the version-delta fallback.
        currentContent: null,
        preApplyContent: "",
        canWrite: false,
      })
    );
  });

  // A settle-time read failure after a LANDED apply is the OPPOSITE case: the
  // pipeline resolves, and mapping it to a failure kind would toast "Failed to
  // save" for a write that succeeded.
  it("a settle-time read throw settles as ok/UNVERIFIED, never as a rejection", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dispatch = await runApply({
        readCanonical: () => {
          throw new Error("boom-settle");
        },
        readVersion: () => 7,
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "applyEditSettled",
          outcome: { kind: "ok" },
          settledVersion: 7,
          currentContent: null,
          divergedAfterApply: false,
        })
      );
      // MIRROR of the version-only test's "no stash drain" negative pin. Here a
      // VERSION was observed, so `ackLabelObserved` is true and the ack Document
      // IS posted — the clause must stay CONDITIONAL rather than deliver a
      // verdict on this event.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("the ack Document is withheld unless some source observed"),
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The verification-loss warn is keyed on `settleReadFailure`, NOT on the
  // `appliedUnverified` tag: a VERSION-only failure keeps the tag `applied` (the
  // content WAS verified) while still putting the self-advance at risk — it is
  // suppressed only when the guarded dispatch retry ALSO fails, which is the
  // arrangement below (`readVersion` throws on every call; the transient
  // counterpart is the retry test further down, where the event carries 9). A
  // tag-keyed warn would make that partial loss silent.
  it("a VERSION-only read failure still warns, though the tag stays applied", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dispatch = await runApply({
        readCanonical: () => "new",
        readVersion: () => {
          throw new Error("boom-version");
        },
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "applyEditSettled",
          outcome: { kind: "ok" },
          settledVersion: null,
          currentContent: "new", // the CONTENT was observed
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("settle-time verification read failed"),
        expect.stringContaining("boom-version")
      );
      // ...and it must name the MISSING OBSERVATION rather than deliver a verdict
      // on the save. This arrangement is precisely where a blanket verdict is
      // false: `readCanonical` succeeded, the divergence compare ran, the tag
      // stayed `applied` — the save WAS verified, only the self-advance is
      // suppressed. "treating it as an UNVERIFIED save" here would assert the
      // verified/unverified conflation the rest of the pipeline removes.
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("UNVERIFIED save"),
        expect.anything()
      );
      // ...and it must say so CONDITIONALLY. On this very arrangement the CONTENT
      // was read, the tag stayed `applied`, and the reducer's `canDrain` can pass
      // — so a flat "no stash drain" would be a false triage claim about the
      // settlement the reader is looking at.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no drain unless the settled CONTENT was read"),
        expect.anything()
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("no stash drain"),
        expect.anything()
      );
      // ...and the version clause must attribute WHICH sources can supply the
      // observation (settle read OR the guarded dispatch retry) rather than a
      // flat "the VERSION was read" — this is the delta a revert of the
      // version clause's reword must turn red.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("the pipeline's settle read or the guarded dispatch retry"),
        expect.anything()
      );
      // ...and it must name the ACK consequence too: `settledVersion` is the ONE
      // signal `ackLabelObserved` reads off this event (host-session-core.ts), so
      // a VERSION-only failure is exactly the case where the ack Document is
      // withheld absent that observation.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("the ack Document is withheld"),
        expect.anything()
      );
      // The no-op short-circuit reaches this same family without submitting an
      // edit, so the warn must not claim a landing either.
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("applyEdit completed"),
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // A FAILURE tag keeps its own outcome, and its triage line must stay NEUTRAL:
  // pairing "treating it as an UNVERIFIED save" with a "Failed to save" toast
  // would put two contradictory claims side by side for one event.
  it("a settle read that fails on a FAILED apply warns without claiming an unverified save", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dispatch = await runApply({
        apply: async () => false,
        readCanonical: () => {
          throw new Error("boom-settle");
        },
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("the outcome itself is unchanged"),
        expect.stringContaining("boom-settle")
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("UNVERIFIED save"),
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("pipeline rejection settles EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply(
      {
        readText: () => {
          throw new Error("boom-read");
        },
      },
      { isDisposed: () => true }
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected" }),
      })
    );
  });

  // The rejection arm must not itself throw — a throw there strands the lock
  // exactly as the missing arm did. A rejection value whose `message` getter
  // throws is the degenerate case the guarded stringifier covers.
  it("rejection arm survives an error whose message getter throws", async () => {
    const hostile = {
      get message() {
        throw new Error("nope");
      },
      toString() {
        throw new Error("nope");
      },
    };
    const dispatch = await runApply({
      readText: () => {
        throw hostile;
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected", message: "unknown error" }),
      })
    );
  });

  // The REJECTION arm's opposite constraint: it must NOT read `canWrite` at all.
  // That seam is itself a candidate throw source, so touching it on the recovery
  // path would strand the lock exactly as the missing arm did. The settled VALUE
  // is already pinned above ("pipeline rejection … STILL settles" asserts
  // `canWrite: false`); what is NOT observable from a value is whether the seam
  // was CONSULTED. `expect(canWrite).not.toHaveBeenCalled()` is therefore the
  // load-bearing assertion here: a refactor that routed this arm through
  // `readCanWrite()` would still emit `canWrite: false` (its guard swallows the
  // throw) and every value assertion would stay green.
  it("rejection arm settles without ever reading canWrite, even when canWrite ALSO throws", async () => {
    const canWrite = vi.fn(() => {
      throw new Error("boom-canWrite");
    });
    const dispatch = await runApply(
      {
        readText: () => {
          throw new Error("boom-read");
        },
      },
      { canWrite }
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected", message: "boom-read" }),
        // The guarded dispatch retry labels this too; see the
        // "pipeline rejection … STILL settles" test.
        settledVersion: 1,
        canWrite: false,
      })
    );
    expect(canWrite).not.toHaveBeenCalled();
  });

  // `canWrite` is an FS/config read in the FULFILMENT arm; an `onRejected`
  // sibling never catches its own `onFulfilled`, so an unguarded throw here
  // strands the lock too. Settle anyway, conservatively read-only.
  it("canWrite throwing does not strand the settlement (assumes read-only)", async () => {
    const dispatch = await runApply(
      { readVersion: () => 8 },
      {
        canWrite: () => {
          throw new Error("boom-canWrite");
        },
      }
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok" },
        settledVersion: 8,
        canWrite: false,
      })
    );
  });

  // Contract: the wrapper maps from the OUTCOME's settled version. The dispatch
  // retry (readVersionGuarded) fires ONLY when the settle-time read failed — a
  // healthy seam like this one's never does, so the version is read exactly
  // once. An UNCONDITIONAL re-read would make this call count 2 and redden.
  it("maps from settledVersion; the dispatch retry fires only when the settle read failed", async () => {
    const readVersion = vi.fn(() => 5);
    const dispatch = await runApply({ readVersion });
    // Exactly one version read — the executor's verify. The retry is conditional.
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "ok" }, settledVersion: 5 })
    );
  });

  // The settlement-dispatch retry (liveness): a TRANSIENT version-read failure
  // must not withhold the ack. The retried value is a LABEL and an input to the
  // reducer's content-unobserved version-delta verdict; that is sound because
  // the retry runs microtasks after the settle-time read with no possibility of
  // an interleaved document event on the single-threaded extension host — it
  // observes the same live version the settle read would have.
  it("retries readVersion once at dispatch when the settle read failed, and the event carries the retried value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const readVersion = vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom-version-transient");
        }
        return 9;
      });
      const dispatch = await runApply({ readVersion, readCanonical: () => "new" });
      expect(readVersion).toHaveBeenCalledTimes(2); // settle read (threw) + ONE dispatch retry
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "applyEditSettled", settledVersion: 9 })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a PERSISTENT version-read failure settles with settledVersion null (the retry is guarded, no throw)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const readVersion = vi.fn(() => {
        throw new Error("boom-version");
      });
      const dispatch = await runApply({ readVersion, readCanonical: () => "new" });
      expect(readVersion).toHaveBeenCalledTimes(2); // one settle read + one retry, never more
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "applyEditSettled", settledVersion: null })
      );
      // The guarded reader serves three call families with different
      // consequences, so its warn NAMES the site — without it this line is
      // indistinguishable from a withheld edit-rejected recovery reseed.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("guarded readVersion failed"),
        { site: "settlement-retry" },
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // PR #409 cycle 2. The guards on `readVersion` / `canWrite` make those seams
  // safe to read while BUILDING the settlement event — but each guard reported
  // through a bare console call, at a position this module's own positional rule
  // calls out: anything evaluated on the way INTO `deps.dispatch` runs before
  // `applyEditSettled` fires, so a throw there skips the dispatch and strands the
  // write lock. That made a SINGLE console failure sufficient, on the path whose
  // entire job is to release the lock.
  //
  // Both seams throw here, and so does the console in both directions, so the
  // test is red if EITHER report escapes containment — one test covering two call
  // sites, each independently revert-checkable.
  it("a throwing console cannot skip the settlement dispatch when the fulfilment arm's guarded reads fail", async () => {
    // The warn throws on its FIRST call only (a `…Once` implementation ahead of
    // a no-op base), and that call is `readVersionGuarded`'s — the PRE-dispatch
    // position under test. The fulfilment arm's second warn (the
    // `settleReadFailure` triage line) sits AFTER `deps.dispatch` and is
    // deliberately left unguarded, its documented cost being an unhandled
    // rejection; making it throw here would assert that documented cost instead
    // of this containment, and would fail the run on the unhandled rejection it
    // is supposed to produce.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnSpy.mockImplementationOnce(() => {
      throw new Error("console.warn failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed");
    });
    try {
      const dispatch = await runApply(
        {
          readVersion: () => {
            throw new Error("boom-version");
          },
          readCanonical: () => "new",
        },
        {
          canWrite: () => {
            throw new Error("boom-canWrite");
          },
        }
      );
      // THE assertion: the lock-releasing event still went out. Both unobserved
      // values are the conservative ones the guards promise.
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "applyEditSettled",
          settledVersion: null,
          canWrite: false,
        })
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // The same defect on the REJECTION arm, where it was worst: that arm's leading
  // `console.error` sat OUTSIDE its own `try`, so one throwing console call
  // skipped the dispatch on the arm its own comment calls "the write lock's
  // release valve". No second fault needed.
  it("the rejection arm's leading log cannot skip the dispatch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed");
    });
    try {
      const dispatch = await runApply({
        readText: () => {
          throw new Error("boom-read");
        },
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "applyEditSettled",
          outcome: expect.objectContaining({ kind: "rejected" }),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("the REJECTION arm also retries (guarded): a working version seam labels even a rejected pipeline", async () => {
    const readVersion = vi.fn(() => 4);
    const dispatch = await runApply({
      readText: () => {
        throw new Error("boom-read");
      },
      readVersion,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({ kind: "rejected" }),
        settledVersion: 4,
      })
    );
  });

  it("the REJECTION arm's retry failing does not strand the lock (settles with settledVersion null)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const readVersion = vi.fn(() => {
        throw new Error("boom-version");
      });
      const dispatch = await runApply({
        readText: () => {
          throw new Error("boom-read");
        },
        readVersion,
      });
      // The retry WAS attempted, exactly once (the pipeline itself never reads
      // the version on a synchronous-prefix rejection). This is what makes the
      // test red before the retry exists — the value assertion alone is
      // already satisfied by Task 1's hardcoded null (Explore r2 New-1).
      expect(readVersion).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: expect.objectContaining({ kind: "rejected" }),
          settledVersion: null,
        })
      );
      // The site token is per-ARM, and the union type cannot catch a valid token
      // stamped onto the wrong arm — only this assertion can.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("guarded readVersion failed"),
        { site: "rejection-arm-first-read" },
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

const rejErr = { code: "unsafe_url", message: "bad" } as const;

describe("effect-executor sendEditRejected (via postEditRejected effect)", () => {
  // readVersion → 11 so the editRejectedDeliveryFailed dispatch's documentVersion
  // is a distinctive value read from the live seam (not the stale
  // lastAppliedDocVersion 3) — the recovery reseed must carry the live version.
  function runReject(over: Partial<EffectExecutorDeps<FakeEdit>> = {}) {
    const { runEffects } = createEffectExecutor(
      makeDeps({
        getState: () => ({ lastAppliedDocVersion: 3 }) as unknown as HostSessionState,
        applyEditSeam: {
          readText: () => "",
          readVersion: () => 11,
          readCanonical: () => "",
          canonicalize: (t) => t,
          build: () => fakeEdit,
          apply: async () => true,
        },
        ...over,
      })
    );
    runEffects([{ type: "postEditRejected", error: rejErr, id: 42 }]);
  }

  it("ok=true: records, no editRejectedDeliveryFailed dispatch", async () => {
    const dispatch = vi.fn();
    const recordEvent = vi.fn();
    runReject({ send: vi.fn(async () => true), dispatch, recordEvent });
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ok=false: dispatches editRejectedDeliveryFailed(id)", async () => {
    const dispatch = vi.fn();
    runReject({ send: vi.fn(async () => false), dispatch });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("reject: dispatches editRejectedDeliveryFailed(id)", async () => {
    const dispatch = vi.fn();
    runReject({ send: () => Promise.reject(new Error("x")), dispatch });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("send() sync throw: dispatches editRejectedDeliveryFailed(id) synchronously", () => {
    const dispatch = vi.fn();
    runReject({
      send: () => {
        throw new Error("sync");
      },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("disposed before send: early return, no send, no dispatch", () => {
    const dispatch = vi.fn();
    const send = vi.fn(async () => true);
    runReject({ isDisposed: () => true, send, dispatch });
    expect(send).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // error-handler B: both .then arms carry a disposed guard. Pinned HERE (in the
  // task that implements them), not deferred — a dropped guard would dispatch
  // editRejectedDeliveryFailed into a disposed panel and violate the reducer's
  // post-dispose invariant.
  it("disposed after send, before OK-false callback: no editRejectedDeliveryFailed", async () => {
    let disposed = false;
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const dispatch = vi.fn();
    runReject({ isDisposed: () => disposed, send, dispatch });
    disposed = true;
    resolveSend(false); // false arm would dispatch — but disposed guard blocks it
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("disposed after send, before reject callback: no editRejectedDeliveryFailed", async () => {
    let disposed = false;
    let rejectSend!: (err: unknown) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((_res, rej) => {
          rejectSend = rej;
        })
    );
    const dispatch = vi.fn();
    runReject({ isDisposed: () => disposed, send, dispatch });
    disposed = true;
    rejectSend(new Error("detached"));
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Codex #4: sendEditRejected wraps `Promise.resolve(pending).then(...)` so a
  // non-standard Thenable that resolves its callback SYNCHRONOUSLY cannot
  // re-enter the active dispatch drain — the feedback lands in a fresh
  // microtask. If someone replaces it with a bare `pending.then`, the dispatch
  // fires synchronously and this goes red.
  it("sync-resolving thenable: editRejectedDeliveryFailed lands in a microtask, not synchronously", async () => {
    const dispatch = vi.fn();
    // A thenable whose then() invokes the callback synchronously with false.
    const syncThenable = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable for testing Promise.resolve assimilation
      then: (onF: (ok: boolean) => void) => {
        onF(false);
      },
    } as unknown as Thenable<boolean>;
    runReject({ send: () => syncThenable, dispatch });
    expect(dispatch).not.toHaveBeenCalled(); // deferred by Promise.resolve assimilation
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  // sendEditRejected's recovery dispatch shares this PR's failure model: its
  // three dispatch sites run exactly when delivery is failing, and readVersion
  // is a documented throw source (Fable r2 85 + error-handler r2 85,
  // independently). The dispatch MUST still fire (a stuck pending rejection
  // suppresses visible-edge resync) — but with `documentVersion: null`, NEVER a
  // fabricated number (Codex r3 99: a stored-version fallback would ship live
  // bytes at a stale label through the recovery reseed).
  it("recovery dispatch survives a broken readVersion at the SYNC-throw site: dispatches with an UNOBSERVED version", () => {
    const dispatch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      runReject({
        send: () => {
          throw new Error("sync transport throw");
        },
        dispatch,
        applyEditSeam: {
          ...seamFor(),
          readVersion: () => {
            throw new Error("boom-version");
          },
        },
      });
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: null,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("guarded readVersion failed"),
        { site: "edit-rejected-recovery:sync-throw" },
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // The .then sites are the more insidious mode: unguarded, their throw became
  // an UNHANDLED REJECTION and the dispatch never fired (Explore r3 T2).
  it("recovery dispatch survives a broken readVersion at the delivery-REFUSED site: dispatches with an UNOBSERVED version", async () => {
    const dispatch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      runReject({
        send: vi.fn(async () => false),
        dispatch,
        applyEditSeam: {
          ...seamFor(),
          readVersion: () => {
            throw new Error("boom-version");
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: null,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("guarded readVersion failed"),
        { site: "edit-rejected-recovery:refused" },
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // The THIRD site (the .then onRejected arm) — same shape, pinned for
  // completeness so no dispatch site is unguarded-by-regression (Codex r4 93).
  it("recovery dispatch survives a broken readVersion at the delivery-REJECTED site: dispatches with an UNOBSERVED version", async () => {
    const dispatch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      runReject({
        send: () => Promise.reject(new Error("detached")),
        dispatch,
        applyEditSeam: {
          ...seamFor(),
          readVersion: () => {
            throw new Error("boom-version");
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: null,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("guarded readVersion failed"),
        { site: "edit-rejected-recovery:rejected" },
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // The THREE tests below are the same shape as the three above, one altitude
  // down: those pin that a broken `readVersion` cannot stop the recovery
  // dispatch, these pin that a broken CONSOLE cannot either. Each recovery
  // dispatch had a bare report ahead of it, so one console fault skipped the
  // dispatch — measured as `dispatched: []`. Without the dispatch the rejection
  // stays `pending`: the webview keeps a banner it cannot resolve, its single
  // flight stays parked, and visible-edge resync is suppressed by the pending
  // gate, so nothing the HOST does clears it. One test per site, because a wrap
  // with no pin of its own is the one that regresses (measured for the
  // `showError` sibling).
  it("recovery dispatch survives a throwing console at the SYNC-THROW site", () => {
    const dispatch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed");
    });
    try {
      runReject({
        send: () => {
          throw new Error("sync transport throw");
        },
        dispatch,
      });
      expect(errorSpy).toHaveBeenCalledOnce(); // the throwing report really ran
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: 11,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("recovery dispatch survives a throwing console at the delivery-REFUSED site (no unhandled rejection)", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    // This site's primary report is a `console.warn`, and `reportContained`'s
    // catch is inert — so there is no second console call to observe here, only
    // the dispatch that must still happen.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console.warn failed");
    });
    try {
      const dispatch = vi.fn();
      runReject({ send: vi.fn(async () => false), dispatch });
      await Promise.resolve();
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: 11,
      });
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warnSpy.mockRestore();
    }
  });

  // The delivery-refused site is the ONE whose payload reads injected seams
  // (`deps.uriString()` / `deps.getState().lastAppliedDocVersion`). Wrapping the
  // console call while leaving those reads OUTSIDE the thunk would contain only
  // half the site: argument evaluation happens before the call, so a throwing
  // seam would skip the dispatch exactly as a throwing console did. This pins the
  // reads as being inside.
  it("recovery dispatch survives a THROWING SEAM READ in the delivery-refused payload (the reads are inside the thunk)", async () => {
    const dispatch = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      runReject({
        send: vi.fn(async () => false),
        dispatch,
        getState: () => {
          throw new Error("getState failed");
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: 11,
      });
      // The log line itself is the acceptable loss: the payload could not be
      // built, so nothing was warned.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("recovery dispatch survives a throwing console at the delivery-REJECTED site (no unhandled rejection)", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    const dispatch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed");
    });
    try {
      runReject({ send: () => Promise.reject(new Error("detached")), dispatch });
      await Promise.resolve();
      await Promise.resolve();
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith({
        type: "editRejectedDeliveryFailed",
        id: 42,
        documentVersion: 11,
      });
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });
});

describe("effect-executor runEffects other cases", () => {
  it("postDocument: posts a document message", async () => {
    const send = vi.fn(async () => true);
    const buildSeedDocument = vi.fn(
      (v: number) =>
        ({
          protocol: 1,
          type: "document",
          content: "x",
          docVersion: v,
          canWrite: true,
          themeKind: "light",
        }) as HostToWebview
    );
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 5, externalEpoch: 2, epochGeneration: 88 }]);
    // The builder receives the core-managed identity pair from the effect.
    expect(buildSeedDocument).toHaveBeenCalledWith(5, 2, 88);
    expect(send).toHaveBeenCalled();
  });

  it("postRejectedDraft: posts document THEN routes edit-rejected via sendEditRejected", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (m: HostToWebview) => {
      calls.push(m.type);
      return true;
    });
    const { runEffects } = createEffectExecutor(
      makeDeps({
        send,
        getState: () => ({ lastAppliedDocVersion: 0 }) as unknown as HostSessionState,
      })
    );
    runEffects([
      {
        type: "postRejectedDraft",
        content: "c",
        docVersion: 2,
        externalEpoch: 0,
        epochGeneration: 1,
        error: rejErr,
        id: 9,
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    // document first, edit-rejected second (order is load-bearing)
    expect(calls).toEqual(["document", "edit-rejected"]);
  });

  it("postTheme: posts a theme message", () => {
    const send = vi.fn(async () => true);
    const { runEffects } = createEffectExecutor(makeDeps({ send }));
    runEffects([{ type: "postTheme", themeKind: "hc-light" }]);
    expect(send).toHaveBeenCalled();
  });

  it("showError: forwards to deps.showError", () => {
    const showError = vi.fn();
    const { runEffects } = createEffectExecutor(makeDeps({ showError }));
    runEffects([{ type: "showError", message: "nope" }]);
    expect(showError).toHaveBeenCalledWith("nope");
  });

  // `runEffects` MUST NOT UNWIND. The reducer emits every non-ok settlement as
  // [showError, postDocument] (toast first — see `settlementEffects`' ORDER note),
  // and since `settle()` became total the correlated case (a failure tag whose
  // settle read also threw) resolves through the UNWRAPPED fulfilment arm rather
  // than the rejection arm's try/catch. `window.showErrorMessage` can throw
  // SYNCHRONOUSLY (the same assumption the reseed-build guard already makes, and
  // `showSafely` only absorbs the Thenable's async rejection), and
  // `createDrainingDispatcher` has try/finally with NO catch — so an unguarded
  // throw here escapes as an unhandled rejection AND abandons the rest of the
  // list.
  it("showError: a SYNCHRONOUS throw is contained — logged, and the following effects still run", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onUnhandled);
    try {
      const send = vi.fn(async () => true);
      const showError = vi.fn(() => {
        throw new Error("toast failed");
      });
      const { runEffects } = createEffectExecutor(makeDeps({ send, showError }));

      // The exact shape `settlementEffects` emits for a non-ok settlement.
      expect(() =>
        runEffects([
          { type: "showError", message: "Failed to save: boom" },
          { type: "postDocument", docVersion: 3, externalEpoch: 0, epochGeneration: 1 },
        ])
      ).not.toThrow();

      expect(showError).toHaveBeenCalledOnce(); // the attempt really happened
      // (b) the ack Document that FOLLOWS the toast still went out — the property
      // an unwinding effect loop destroys.
      expect(send).toHaveBeenCalled();
      // (c) the throw is not swallowed silently, and the report carries the
      // incident's IDENTITY — which toast was lost. The bare catch discarded it,
      // leaving triage with "a toast threw" and no way to tell WHICH.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("showError threw"),
        "Failed to save: boom",
        expect.anything()
      );
      await Promise.resolve();
      expect(rejections).toEqual([]); // (a) nothing escaped
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });

  // Sibling of the logWarn both-consoles-throw test below, for the arm whose
  // abandoned tail is the ack `postDocument`. Until this test, `case "showError"`
  // was the ONE `reportContained` call site with no pin of its own: reverting it
  // to a bare `console.error` left the whole file green (measured), which is
  // exactly the asymmetry that makes an unpinned guard the one that regresses.
  it("showError: the guard's OWN fallback report cannot unwind — BOTH console methods throwing still runs the postDocument that FOLLOWS", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed too");
    });
    try {
      const send = vi.fn(async () => true);
      const showError = vi.fn(() => {
        throw new Error("toast failed");
      });
      const { runEffects } = createEffectExecutor(makeDeps({ send, showError }));

      // The exact shape `settlementEffects` emits for a non-ok settlement.
      expect(() =>
        runEffects([
          { type: "showError", message: "Failed to save: boom" },
          { type: "postDocument", docVersion: 3, externalEpoch: 0, epochGeneration: 1 },
        ])
      ).not.toThrow();

      expect(showError).toHaveBeenCalledOnce(); // the attempt really happened
      expect(errorSpy).toHaveBeenCalledOnce(); // …and so did its fallback report
      // THE assertion: the ack Document survived a console that fails in BOTH
      // directions.
      expect(send).toHaveBeenCalled();
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });

  // `post`'s SYNC-THROW catch is a containment boundary like the two above, and
  // it reported through a bare console until this test. The cost is not confined
  // to `post`: `case "postRejectedDraft"` calls `post` and then, on the very next
  // line, `sendEditRejected` — so an escape from this catch takes the whole
  // remainder of the effect list with it. Pinned with the generic shape (a post
  // effect followed by another effect) so the property is the effect loop's, not
  // one arm's.
  it("post: a throwing report inside the sync-throw catch cannot unwind — the effect that FOLLOWS still runs", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed too");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const send = vi.fn(() => {
        throw new Error("sync transport throw");
      });
      const { runEffects } = createEffectExecutor(makeDeps({ send }));

      expect(() =>
        runEffects([
          { type: "postTheme", themeKind: "dark" },
          { type: "logWarn", message: "[quoll] the tail that must survive", detail: {} },
        ])
      ).not.toThrow();

      expect(send).toHaveBeenCalledOnce(); // the throwing attempt really happened
      expect(errorSpy).toHaveBeenCalledOnce(); // …and so did its contained report
      // THE assertion: the effect loop reached the next effect.
      expect(warnSpy).toHaveBeenCalledWith("[quoll] the tail that must survive", {});
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("openExternal: forwards href to deps.openExternal", () => {
    const openExternal = vi.fn();
    const { runEffects } = createEffectExecutor(makeDeps({ openExternal }));
    runEffects([{ type: "openExternal", href: "https://x.test" }]);
    expect(openExternal).toHaveBeenCalledWith("https://x.test");
  });

  it("logWarn: does not throw, does not post", () => {
    const send = vi.fn(async () => true);
    const { runEffects } = createEffectExecutor(makeDeps({ send }));
    expect(() => runEffects([{ type: "logWarn", message: "w", detail: {} }])).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  // The triage line the fixture below logs — also the identity the fallback
  // report must carry, so it is spelled once and asserted from here.
  const drainLogMessage = "[quoll] unlabelled drain";

  // The drain `accept` arm's VERBATIM effect shape (host-session-core's
  // `applyEditSettled` case returns `[...staleReBaseWarn, applyEdit]`): a triage
  // log AHEAD of the write, `logWarn` being the case `runEffects` once ran with
  // no `try` of its own. Shared by the two containment tests below so the one
  // fixture they both rest on cannot drift apart.
  //
  // That ordering is what makes a throw from the log cost more than a lost line
  // — the committed state has already RE-ACQUIRED the write lock, so an
  // abandoned `applyEdit` means no `applyEditSettled` is ever dispatched and the
  // lock is stranded for the panel's life. The `settlementTransitionFailed`
  // recovery does NOT cover it: that hangs off the transition catch in
  // `host-session-step.ts` and never sees a `runEffects` throw.
  //
  // Running the list is part of the fixture, non-throw assertion included: that
  // is the property BOTH tests exist to hold. Returns the seam's `build`, which
  // is how the write is observed — safe to assert synchronously because
  // `execute-write.ts`'s pipeline runs `readText → span → build →
  // apply-initiation` BEFORE its first `await` (see that module's header).
  const runDrainShapedLogWarnThenWrite = () => {
    const build = vi.fn(() => fakeEdit);
    const { runEffects } = createEffectExecutor(
      makeDeps({
        applyEditSeam: {
          readText: () => "",
          readVersion: () => 6,
          readCanonical: () => "drained",
          canonicalize: (text) => text,
          build,
          apply: async () => true,
        },
      })
    );

    expect(() =>
      runEffects([
        { type: "logWarn", message: drainLogMessage, detail: {} },
        { type: "applyEdit", content: "drained", baseDocVersion: 6 },
      ])
    ).not.toThrow();

    return build;
  };

  it("logWarn: a throwing console.warn is contained — logged, and the applyEdit that FOLLOWS still runs", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console.warn failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const build = runDrainShapedLogWarnThenWrite();

      expect(warnSpy).toHaveBeenCalledOnce(); // the attempt really happened
      // THE assertion: the write survived the throwing log.
      expect(build).toHaveBeenCalledOnce();
      // …and the throw is not swallowed silently, WITH the identity of the log
      // line that was lost (the bare catch reported neither).
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("logWarn threw"),
        drainLogMessage,
        expect.anything()
      );
      await Promise.resolve();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // PR #409 cycle 2: the guard added above reports its own failure through a
  // SECOND console call, and until this test that fallback was itself unguarded.
  // VS Code patches the console as ONE IPC family, so "console.warn throws but
  // console.error is fine" is the optimistic case — the correlated case is BOTH,
  // and there the throw escaped `runEffects` from inside the very guard meant to
  // contain it. The shared fixture is the drain `accept` arm's verbatim shape,
  // so the cost is the WRITE plus a lock stranded for the panel's life.
  it("logWarn: the guard's OWN fallback report cannot unwind — BOTH console methods throwing still runs the applyEdit that FOLLOWS", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console.warn failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed too");
    });
    try {
      const build = runDrainShapedLogWarnThenWrite();

      // Both attempts really happened — the primary log and its fallback report.
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
      // THE assertion: the write survived a console that fails in BOTH directions.
      expect(build).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // Codex #5: builder freshness. The seed builder must be CALLED at each
  // postDocument (reading live theme/canWrite), not memoised at factory
  // construction. Flip a live value between factory build and the effect, and
  // assert the second postDocument carries the NEW value.
  it("postDocument re-invokes the builder each time (live freshness)", () => {
    let themeKind: "light" | "dark" = "light";
    const seen: string[] = [];
    const send = vi.fn(async (m: HostToWebview) => {
      seen.push((m as { themeKind: string }).themeKind);
      return true;
    });
    const buildSeedDocument = (v: number): HostToWebview =>
      ({
        protocol: 1,
        type: "document",
        content: "",
        docVersion: v,
        canWrite: true,
        themeKind,
        externalEpoch: 0,
        epochGeneration: 1,
      }) as HostToWebview;
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 1, externalEpoch: 0, epochGeneration: 1 }]);
    themeKind = "dark"; // theme changes AFTER the factory was built
    runEffects([{ type: "postDocument", docVersion: 2, externalEpoch: 0, epochGeneration: 1 }]);
    expect(seen).toEqual(["light", "dark"]);
  });
});

describe("effect-executor showResyncFailure (withheld settlement ack)", () => {
  it("toasts once, and shares its latch with the postDocument build-failure guard", () => {
    const showError = vi.fn();
    const buildSeedDocument = vi.fn(() => {
      throw new Error("boom-seed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runEffects } = createEffectExecutor(makeDeps({ showError, buildSeedDocument }));
      runEffects([{ type: "showResyncFailure" }]);
      runEffects([{ type: "showResyncFailure" }]); // same incident → latched
      expect(showError).toHaveBeenCalledTimes(1);
      // The OTHER trigger is latched by the SAME flag: a failing reseed build in
      // the same incident must not toast a second time.
      runEffects([{ type: "postDocument", docVersion: 1, externalEpoch: 0, epochGeneration: 7 }]);
      expect(showError).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a THROWING toast is contained and spends the latch", () => {
    const showError = vi.fn(() => {
      throw new Error("toast failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runEffects } = createEffectExecutor(makeDeps({ showError }));
      expect(() => runEffects([{ type: "showResyncFailure" }])).not.toThrow();
      runEffects([{ type: "showResyncFailure" }]);
      expect(showError).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to report the withheld settlement ack"),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The reseed build-failure guard's own comment says the state it creates must
  // NOT be SILENT — and it used to place a BARE `console.error` AHEAD of the
  // toast that is the whole signal, so one console fault broke that condition
  // (measured: `toastAttempts: 0`). Both halves of the fix are pinned here at
  // once, because either one alone leaves the property false: the toast now goes
  // FIRST (the module's own order rule — user-visible signal ahead of triage
  // log), and the log is contained.
  it("postDocument build failure: a throwing console still leaves ONE toast attempt (signal ahead of the log)", () => {
    const showError = vi.fn();
    const buildSeedDocument = vi.fn(() => {
      throw new Error("boom-seed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed");
    });
    try {
      const { runEffects } = createEffectExecutor(
        makeDeps({ showError, buildSeedDocument, send: vi.fn(async () => true) })
      );
      expect(() =>
        runEffects([{ type: "postDocument", docVersion: 1, externalEpoch: 0, epochGeneration: 1 }])
      ).not.toThrow();
      // THE assertion: the user-visible signal was attempted despite the console
      // failing. ⚠️ This observes the CONTAINMENT, not the statement order — with
      // the log contained, the signal is reached from either position. The order
      // is deliberate but unobservable here; see the guard's own comment for the
      // configuration that separates them, and note that this test stays GREEN if
      // someone puts the log back in front.
      expect(showError).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // `reportResyncFailure`'s OWN fallback was the last bare report in the module,
  // and it sits in the most correlated position of all: it runs only because
  // `deps.showError` just threw. Both callers are inside a boundary a throw must
  // not unwind, so an escape here abandoned the rest of the effect list — for the
  // withhold pair that is the triage `logWarn`, which is emitted AFTER the
  // signal. Two faults, both consoles included, and the tail must still run.
  it("the resync-failure guard's OWN fallback cannot unwind — a throwing toast AND a throwing console still run the effect that FOLLOWS", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    const showError = vi.fn(() => {
      throw new Error("toast failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error failed too");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { runEffects } = createEffectExecutor(makeDeps({ showError }));
      // The VERBATIM shape `withholdAckEffects` builds: the signal, then triage.
      expect(() =>
        runEffects([
          { type: "showResyncFailure" },
          { type: "logWarn", message: "[quoll] settlement ack withheld", detail: {} },
        ])
      ).not.toThrow();

      expect(showError).toHaveBeenCalledOnce(); // the toast attempt happened
      expect(errorSpy).toHaveBeenCalledOnce(); // …and so did its contained report
      // THE assertion: the triage line that FOLLOWS survived a console failing in
      // both directions.
      expect(warnSpy).toHaveBeenCalledWith("[quoll] settlement ack withheld", {});
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
