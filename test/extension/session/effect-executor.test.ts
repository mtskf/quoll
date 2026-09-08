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
        outcome: { kind: "ok", documentVersion: 8 },
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
        outcome: { kind: "ok", documentVersion: 8 },
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
        outcome: { kind: "ok", documentVersion: 9 },
      })
    );
  });

  it("refused settlement dispatches EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply({ apply: async () => false }, { isDisposed: () => true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
    );
  });

  // Settlement is the write lock's ONLY release valve (host-session-core clears
  // `pendingApplyBaseVersion` on `applyEditSettled` and nowhere else but
  // dispose), so BOTH promise arms must reach `dispatch`. execute-write GUARDS its
  // two settle-time verification reads individually now, so the surviving
  // rejection source is its SYNCHRONOUS prefix (`readText` / `canonicalize`) —
  // which runs before anything can land, so a rejection there really does
  // describe a write that never happened. Previously such a rejection was left
  // unhandled by the bare `void ….then(onFulfilled)` (`void` discards the promise
  // reference, it does not catch) and the lock was held for the session.
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
        // NOT OBSERVED — nothing was read, so the settlement says so rather than
        // fabricating bytes. Safe because the outcome is non-ok (`canDrain`
        // requires `ok`, so it never reaches `decideEdit`) and because the
        // foreign-bytes check reads `null` as "not foreign" → no spurious epoch
        // bump.
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
    const dispatch = await runApply({
      readCanonical: () => {
        throw new Error("boom-settle");
      },
      readVersion: () => 7,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 7 },
        currentContent: null,
        divergedAfterApply: false,
      })
    );
  });

  // The verification-loss warn is keyed on `settleReadFailure`, NOT on the
  // `appliedUnverified` tag: a VERSION-only failure keeps the tag `applied` (the
  // content WAS verified) while still suppressing the self-advance, so a
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
          outcome: { kind: "ok", documentVersion: null },
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
        outcome: { kind: "ok", documentVersion: 8 },
        canWrite: false,
      })
    );
  });

  // Contract: the wrapper maps from the OUTCOME and does not re-read the
  // document. For an ok settlement the executor reads the settled version once
  // (inside verify); the wrapper must NOT read it again (a re-read could observe
  // a later edit and mis-version the settlement).
  it("does NOT re-read the document version after the outcome (maps from settledVersion)", async () => {
    const readVersion = vi.fn(() => 5);
    const dispatch = await runApply({ readVersion });
    // Exactly one version read — the executor's verify. The wrapper adds none.
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "ok", documentVersion: 5 } })
    );
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
      // (c) the throw is not swallowed silently.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("showError threw"),
        expect.anything()
      );
      await Promise.resolve();
      expect(rejections).toEqual([]); // (a) nothing escaped
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
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
