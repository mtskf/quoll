import { describe, expect, it, type MockInstance, vi } from "vitest";
import { createEditSync } from "../../src/webview/cm/edit-sync.js";

type Posted = { content: string; baseDocVersion: number };

function setup(opts?: {
  blockPost?: () => boolean;
  failPost?: boolean;
  now?: () => number;
  onResyncStorm?: () => void;
  onLocalEditDiscarded?: () => void;
  onReadonlyHold?: () => boolean;
}) {
  let doc = "hello";
  const posted: Posted[] = [];
  let postOk = !opts?.failPost;
  const sync = createEditSync({
    getDoc: () => doc,
    // Mirrors canPostEdit (state.ts, wired through editor.ts): the
    // save-policy gate. Default: unblocked. blockPost() returns true
    // when posting should be BLOCKED, so canPost inverts it.
    canPost: () => (opts?.blockPost ? !opts.blockPost() : true),
    post: (content, baseDocVersion) => {
      if (!postOk) {
        return false; // postMessage threw
      }
      posted.push({ content, baseDocVersion });
      return true;
    },
    // Synchronous flush so tests need no fake timers.
    scheduleFlush: (run) => run(),
    now: opts?.now,
    onResyncStorm: opts?.onResyncStorm,
    onLocalEditDiscarded: opts?.onLocalEditDiscarded,
    onReadonlyHold: opts?.onReadonlyHold,
  });
  return {
    sync,
    posted,
    type: (next: string) => {
      doc = next;
      sync.onLocalChange();
    },
    setDoc: (next: string) => {
      doc = next;
    },
    setPostOk: (ok: boolean) => {
      postOk = ok;
    },
  };
}

describe("cm edit-sync", () => {
  // Every host ack mirrors production — onHostSnapshot (record-only
  // metadata) then onReducerCommit(committedEditInFlight), the SINGLE
  // drain editor.ts fires from one post-commit call. `ack` passes
  // editInFlight=false (the reducer's document arm cleared it). Helpers keep
  // the tests readable AND honest: they drive the SAME calls the production
  // path makes, so a missed-trigger bug cannot hide behind a hand-rolled
  // drain.
  const ack = (s: ReturnType<typeof setup>, v: number, canWrite = true) => {
    s.sync.onHostSnapshot(v, canWrite, 0, 1);
    s.sync.onReducerCommit(false); // reducer's document arm cleared editInFlight
  };
  // A consent flip / serialize-error clear: reducer state changed, NOT
  // in-flight, no docVersion move. Production fires onReducerCommit(false).
  const consentFlip = (s: ReturnType<typeof setup>) => s.sync.onReducerCommit(false);

  it("posts the current doc with the base docVersion on a local change", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("hello world");
    expect(s.posted).toEqual([{ content: "hello world", baseDocVersion: 1 }]);
  });

  it("buffers a second change while in flight, replays on the next ack", () => {
    // Review fix #25: the ack-drain is onReducerCommit(false), fired by the
    // post-commit effect. The test mirrors that snapshot→commit sequence.
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts, editInFlight = true
    s.type("ab"); // in flight → buffered, not posted
    expect(s.posted.length).toBe(1);
    ack(s, 2); // host ack at v2 → onReducerCommit(false) clears + drains
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });

  it("drains on a same-docVersion ack (write-lock-recovery ack)", () => {
    // The host posts a SAME-docVersion Document to ack an applied Edit
    // (state.test.ts:157-198). The shell's dispatch wrapper calls
    // onReducerCommit on every state-changing transition (including the
    // editInFlight flip), so the drain fires even though docVersion did
    // not move. An earlier docVersion-only trigger missed this and
    // stranded the buffer.
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts at v1, editInFlight = true
    s.type("ab"); // buffered while in flight
    expect(s.posted.length).toBe(1);
    ack(s, 1); // SAME docVersion ack → still drains
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 1 });
  });

  it("drains a held buffer when a same-docVersion Document re-grants write", () => {
    // A buffer legitimately held (typed while canWrite=true, in flight) is
    // NOT dropped when a transient readonly Document arrives — replayIfNeeded
    // returns on !canWrite WITHOUT nulling (the content was editable when
    // typed; contrast #13, which drops NEW typing under readonly in trySend).
    // The host then re-grants write on a SAME-docVersion Document
    // (visible-edge / ready resync — quoll-editor-panel.ts:187-197/233-255).
    // onHostSnapshot updates canWrite but docVersion did not move, so the
    // drain effect fires ONLY because state.canWrite is in its deps (review
    // fix #30). Mirror that: snapshot(v, false)→commit holds; snapshot(v,
    // true)→commit drains.
    const s = setup();
    s.sync.onHostSnapshot(2, true, 0, 1);
    s.type("a"); // posts at v2, editInFlight = true
    s.type("ab"); // buffered while in flight (legitimately, canWrite=true)
    expect(s.posted.length).toBe(1);
    // Transient readonly at the SAME docVersion: ack clears in-flight, but
    // the buffer is HELD (not dropped) because canWrite is now false.
    s.sync.onHostSnapshot(2, false, 0, 1);
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(1); // still held — not posted, not dropped
    // Write re-granted at the SAME docVersion. The canWrite flip in the
    // next dispatch triggers onReducerCommit; the held buffer drains.
    s.sync.onHostSnapshot(2, true, 0, 1);
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });

  it("does NOT post a second Edit while one is in flight (Issue3 + #25)", () => {
    // A reducer commit that reports editInFlight=true (e.g. a consent flip
    // mutated state while an Edit is genuinely in flight) must NOT post a
    // concurrent second Edit. onReducerCommit(true) returns early.
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts at v1, editInFlight = true
    s.type("ab"); // buffered while in flight
    expect(s.posted.length).toBe(1);
    s.sync.onReducerCommit(true); // commit while still in flight → must NOT drain
    expect(s.posted.length).toBe(1); // still one; buffer intact
    ack(s, 2); // real ack (editInFlight false) drains it
    expect(s.posted).toEqual([
      { content: "a", baseDocVersion: 1 },
      { content: "ab", baseDocVersion: 2 },
    ]);
  });

  it("drops a readonly local change permanently — no replay after write is granted", () => {
    // Review fix #13: readonly is a HARD DROP, not a buffered hold. A later
    // write-granting ack must NOT replay content typed while readonly.
    const s = setup();
    s.sync.onHostSnapshot(1, false, 0, 1);
    s.type("x"); // readonly → dropped, buffer NOT retained
    expect(s.posted).toEqual([]);
    ack(s, 2, true); // host grants write — must NOT replay "x"
    expect(s.posted).toEqual([]);
  });

  it("does not post while the warning/consent gate blocks", () => {
    let blocked = true;
    const s = setup({ blockPost: () => blocked });
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("x");
    expect(s.posted).toEqual([]); // gate held, buffer retained
    blocked = false;
    // Drain via the consent-flip commit (the real trigger), NOT a
    // synthetic onLocalChange. "Save anyway" mutates reducer state only
    // — no docChanged — so the consent transition in the shell's
    // dispatch wrapper fires onReducerCommit(false).
    consentFlip(s);
    expect(s.posted).toEqual([{ content: "x", baseDocVersion: 1 }]);
  });

  it("drains a buffer blocked by the gate when the gate opens, with no docChanged", () => {
    // Review fix #3: proves the drain path does NOT depend on a local edit
    // firing. Buffer captured while blocked; only the consent-flip commit
    // releases it.
    let blocked = true;
    const s = setup({ blockPost: () => blocked });
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("typed while blocked");
    expect(s.posted).toEqual([]); // held by the gate
    blocked = false;
    consentFlip(s); // gate opens — drain WITHOUT a synthetic local change
    expect(s.posted).toEqual([{ content: "typed while blocked", baseDocVersion: 1 }]);
  });

  it("retains the buffer when post fails (postMessage threw)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.setPostOk(false);
    s.type("x"); // post returns false → buffer retained, not in flight
    expect(s.posted).toEqual([]);
    s.setPostOk(true);
    ack(s, 2); // next commit drains and retries the retained buffer
    expect(s.posted).toEqual([{ content: "x", baseDocVersion: 2 }]);
  });

  it("does not drain a pre-seed buffer", () => {
    // replayIfNeeded's !seeded guard mirrors trySend. A buffer present
    // before the first onHostSnapshot must NOT post with the placeholder
    // docVersion 0. Capture a pre-seed reseed, then a commit before any
    // snapshot — nothing posts. The seed then drops the buffer: its stamp
    // predates any host identity, so the seed's pair supersedes it.
    let doc = "";
    const posted: Posted[] = [];
    const sync = createEditSync({
      getDoc: () => doc,
      canPost: () => true,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
    });
    doc = "pre-seed text";
    sync.onLocalChange();
    sync.cancelPendingFlush(); // captures into buffer pre-seed
    sync.onReducerCommit(false); // commit before any snapshot → must NOT post
    expect(posted).toEqual([]);
    sync.onHostSnapshot(1, true, 0, 1); // first seed
    sync.onReducerCommit(false); // pre-seed stamp superseded → dropped
    expect(posted).toEqual([]);
  });

  it("ignores a stale host snapshot (older docVersion)", () => {
    // No replay assertion here — the post comes from trySend (onLocalChange).
    // Pins that the stale onHostSnapshot does not clobber the live docVersion
    // the next Edit echoes as its base.
    const s = setup();
    s.sync.onHostSnapshot(5, true, 0, 1);
    s.sync.onHostSnapshot(3, true, 0, 1); // stale — ignored, docVersion stays 5
    s.type("x");
    expect(s.posted).toEqual([{ content: "x", baseDocVersion: 5 }]);
  });

  it("cancelPendingFlush captures the in-window keystroke and never echoes the host bytes", () => {
    // Real timer path: schedule a flush, then take the reseed path before
    // it fires. Production ordering (Task 4.3): applyDocument calls
    // cancelPendingFlush() WHILE the CM doc still holds the user's text,
    // THEN reseeds to the host bytes. So cancelPendingFlush's getDoc() sees
    // "typed" (preserved), never "host-snapshot" (no echo).
    let doc = "hello";
    const posted: Posted[] = [];
    const sync = createEditSync({
      getDoc: () => doc,
      canPost: () => true,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
    });
    sync.onHostSnapshot(1, true, 0, 1);
    doc = "typed";
    sync.onLocalChange(); // schedules a real-timer flush (not yet buffered)
    // Reseed path, in production order: capture-then-cancel happens while
    // doc is still "typed"; the host reseed to "host-snapshot" follows.
    sync.cancelPendingFlush(); // buffers "typed" + clears timer
    doc = "host-snapshot"; // the CM reseed lands AFTER the capture
    expect(posted).toEqual([]); // nothing posted yet (no echo of host bytes)
    // The reducer commit drains the captured keystroke — "typed" survived the
    // reseed, and "host-snapshot" was never echoed.
    sync.onHostSnapshot(2, true, 0, 1);
    sync.onReducerCommit(false);
    expect(posted).toEqual([{ content: "typed", baseDocVersion: 2 }]);
  });

  it("a debounce-window keystroke survives a docVersion-only commit — no silent drop", () => {
    // The exact #23 production path: a keystroke typed inside the 300 ms
    // window (no Edit posted → editInFlight stays false) is captured by
    // cancelPendingFlush (#16) when a Document interrupts; the reducer then
    // commits the `document` arm — editInFlight false→false, gate unchanged,
    // ONLY docVersion moved. The drain MUST fire on that docVersion change.
    // The earlier two-effect split (ack keyed on editInFlight, consent on the
    // gate) had NO effect for a docVersion-only commit → the buffer stranded
    // forever = silent data loss. The single all-triggers effect fixes it.
    // Revert-check: make cancelPendingFlush a bare clearTimer → red (the
    // keystroke is never captured); OR gate onReducerCommit so it skips
    // docVersion-only transitions → red (captured but never drained — the
    // #23 regression itself).
    let doc = "seed";
    const posted: Posted[] = [];
    const sync = createEditSync({
      getDoc: () => doc,
      canPost: () => true,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
    });
    sync.onHostSnapshot(1, true, 0, 1);
    doc = "seed!"; // user typed one char inside the window
    sync.onLocalChange(); // debounced, NOT yet buffered, editInFlight false
    sync.cancelPendingFlush(); // Document interrupts mid-window → captures "seed!"
    doc = "host snapshot"; // host reseed lands after capture
    sync.onHostSnapshot(2, true, 0, 1); // docVersion 1→2, editInFlight still false
    sync.onReducerCommit(false); // ONLY trigger is the docVersion change
    expect(posted).toEqual([{ content: "seed!", baseDocVersion: 2 }]);
  });

  // V-M11 (C3 / Codex Finding 4): the closure-capture race between
  // cancelPendingFlush's captured `buffered` and the next Document's
  // threaded baseDocVersion. Two consecutive Documents arrive inside
  // ONE in-flight window — the buffer captured by the first
  // cancelPendingFlush must survive the second snapshot and replay
  // against THAT version on the next ack.
  //
  // CRITICAL: this test must NOT use the synchronous-scheduleFlush setup
  // (`scheduleFlush: run => run()`), because that path posts immediately
  // on onLocalChange and never leaves a pending timer for
  // cancelPendingFlush to consume. Use fake timers + the real timer
  // path so the buffer-capture branch of cancelPendingFlush actually
  // runs.
  it("two consecutive Documents inside one in-flight window: buffer survives, replays at the latest version", () => {
    vi.useFakeTimers();
    try {
      let doc = "hello";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        // No scheduleFlush override → real setTimeout path runs.
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });

      // Initial host snapshot at v1.
      sync.onHostSnapshot(1, true, 0, 1);
      // First edit posts immediately when the timer fires (this verifies
      // baseline before we exercise the race).
      doc = "a";
      sync.onLocalChange();
      vi.advanceTimersByTime(300);
      // The first edit posted; reducer would set editInFlight=true. We
      // DO NOT call onReducerCommit yet — the host has not ack'd.
      expect(posted.length).toBe(1);
      expect(posted[0]).toEqual({ content: "a", baseDocVersion: 1 });

      // User types inside the NEXT debounce window (timer pending, NOT
      // yet fired).
      doc = "ab";
      sync.onLocalChange();
      // Now the V-M11 race window: a Document arrives BEFORE the timer
      // fires. cancelPendingFlush captures "ab" into the buffer.
      sync.cancelPendingFlush();
      // First Document: snapshot updates to v2 (does NOT clear in-flight
      // — the host re-sent because the write-lock dropped our previous
      // Edit; only the reducer's ack via onReducerCommit clears the flag).
      sync.onHostSnapshot(2, true, 0, 1);
      // Second Document arrives before any commit:
      sync.onHostSnapshot(3, true, 0, 1);
      // Now the reducer commits the ack (editInFlight=false). The
      // buffered "ab" must replay at v3, NOT v1 or v2.
      sync.onReducerCommit(false);

      expect(posted.length).toBe(2);
      expect(posted[1]).toEqual({ content: "ab", baseDocVersion: 3 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cm edit-sync — acksInFlightEdit", () => {
  const ack = (s: ReturnType<typeof setup>, v: number, canWrite = true) => {
    s.sync.onHostSnapshot(v, canWrite, 0, 1);
    s.sync.onReducerCommit(false);
  };

  it("is false before anything is posted", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    expect(s.sync.acksInFlightEdit("hello", 0, 1)).toBe(false);
  });

  it("is true for the exact bytes of the Edit currently in flight", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("hello world"); // posts, editInFlight = true
    expect(s.sync.acksInFlightEdit("hello world", 0, 1)).toBe(true);
    // A different string (a genuine external divergence) never matches.
    expect(s.sync.acksInFlightEdit("something else", 0, 1)).toBe(false);
  });

  it("clears when the reducer commit acks the in-flight Edit", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts, editInFlight = true
    expect(s.sync.acksInFlightEdit("a", 0, 1)).toBe(true);
    ack(s, 2); // ack clears editInFlight
    expect(s.sync.acksInFlightEdit("a", 0, 1)).toBe(false);
  });

  it("tracks the newest in-flight bytes across a buffered replay", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts "a", editInFlight = true
    s.type("ab"); // buffered while in flight
    expect(s.sync.acksInFlightEdit("a", 0, 1)).toBe(true); // still "a" in flight
    ack(s, 2); // ack "a" → replay drains "ab" → "ab" now in flight
    expect(s.sync.acksInFlightEdit("ab", 0, 1)).toBe(true);
    expect(s.sync.acksInFlightEdit("a", 0, 1)).toBe(false);
  });

  it("clears when a post fails (no phantom in-flight echo)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.setPostOk(false);
    s.type("x"); // post returns false → not in flight
    expect(s.sync.acksInFlightEdit("x", 0, 1)).toBe(false);
  });

  // The identity-lineage conjunct. Content equality alone does not make a
  // Document ours: another writer can land byte-identical bytes, and the host
  // reports that as a foreign epoch advance (or a new generation after a host
  // restart). These cases MUST agree with shouldDropBufferedForEpoch — the two
  // read the same `supersedesIdentity` rule so the reseed path never folds a
  // Document whose replay buffer is about to be dropped.
  // Revert-check: delete the `!supersedesIdentity(...)` conjunct → every
  // `toBe(false)` expectation BELOW THIS COMMENT goes red — 4 expectations
  // spread across 4 of the `it` blocks that follow (the earlier `toBe(false)`
  // cases in this describe test the content conjunct instead, and the
  // epoch-REGRESSION case below expects `toBe(true)`; both stay green).
  // Measured, not derived: within THIS file the mutation reds exactly those 4
  // tests. It also reds the display-side pins that read the same conjunct
  // through foldsOkAck — editor.test.ts's (d3) block (3) and shell.test.ts's
  // "forwards the Document's externalEpoch VALUE" (1), 8 in total — which is
  // the point: display and replay share one rule.
  it("is false when a content-equal Document advances the epoch in the same generation", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 11);
    s.type("hello world");
    expect(s.sync.acksInFlightEdit("hello world", 0, 11)).toBe(true); // our lineage
    expect(s.sync.acksInFlightEdit("hello world", 1, 11)).toBe(false); // foreign bytes
  });

  it("is true when a content-equal Document's epoch sits BEHIND ours in the same generation", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 5, 11);
    s.type("hello world");
    // Same generation, epoch 5 → 3. A within-generation regression is not a
    // foreign advance, so our lineage continues and the ok-ack still folds.
    // This is the arm that separates supersedesIdentity's `>` from `!==`; the
    // EQUAL cases elsewhere in this describe (epoch 0 → 0, 3 → 3) separate it
    // from `>=`, so between them the comparison is pinned from both sides.
    expect(s.sync.acksInFlightEdit("hello world", 3, 11)).toBe(true);
  });

  it("is false when a content-equal Document arrives on a new generation", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 3, 11);
    s.type("hello world");
    // A host restart mints a fresh generation and restarts the epoch at 0 —
    // magnitude is meaningless across generations, so even a LOWER epoch is a
    // transition, not an ack.
    expect(s.sync.acksInFlightEdit("hello world", 0, 22)).toBe(false);
    expect(s.sync.acksInFlightEdit("hello world", 3, 11)).toBe(true);
  });

  it("agrees with the replay-buffer drop rule on the same Document", () => {
    // Non-vacuity for the shared-rule claim: for a same-generation epoch
    // advance, the fold is refused AND the buffer is dropped; for the
    // unchanged pair, the fold is allowed AND the buffer replays.
    const advanced = setup();
    advanced.sync.onHostSnapshot(1, true, 0, 11);
    advanced.type("a"); // posts "a"
    advanced.type("ab"); // buffered behind it, stamped at epoch 0
    expect(advanced.sync.acksInFlightEdit("a", 1, 11)).toBe(false);
    advanced.sync.onHostSnapshot(2, true, 1, 11);
    advanced.sync.onReducerCommit(false);
    expect(advanced.posted.map((p) => p.content)).toEqual(["a"]); // "ab" dropped

    const same = setup();
    same.sync.onHostSnapshot(1, true, 0, 11);
    same.type("a");
    same.type("ab");
    expect(same.sync.acksInFlightEdit("a", 0, 11)).toBe(true);
    same.sync.onHostSnapshot(2, true, 0, 11);
    same.sync.onReducerCommit(false);
    expect(same.posted.map((p) => p.content)).toEqual(["a", "ab"]); // replayed
  });

  it("agrees with the drop rule even when the buffer's stamp lags the recorded pair", () => {
    // DELIBERATELY the reverse of production's call order: applyDocument asks
    // acksInFlightEdit FIRST and only then calls onHostSnapshot, so today the
    // held buffer's stamp always equals the recorded pair and this state is
    // unreachable. Recording the snapshot first is how the test MANUFACTURES the
    // divergence — a buffer stamped one epoch behind what the host has since
    // recorded — because that divergence is exactly what the fold must survive:
    // display and replay have to reach the same verdict from the stamp, not from
    // the "stamp === recorded" invariant (which holds only while every accepted
    // Document is followed by a drain). Do not "fix" the order back.
    const lagged = setup();
    lagged.sync.onHostSnapshot(1, true, 0, 11);
    lagged.type("a"); // posts "a", in flight
    lagged.type("ab"); // buffered behind it, stamped at epoch 0
    lagged.sync.onHostSnapshot(2, true, 1, 11); // recorded advances; no drain yet
    // The buffer is now doomed (its stamp lost the epoch race), so the display
    // must NOT fold this Document away as our ack even though the recorded pair
    // alone would call it our own lineage.
    expect(lagged.sync.acksInFlightEdit("a", 1, 11)).toBe(false);
    lagged.sync.onReducerCommit(false);
    expect(lagged.posted.map((p) => p.content)).toEqual(["a"]); // "ab" dropped
  });
});

describe("cm edit-sync — discardBuffer", () => {
  const ack = (s: ReturnType<typeof setup>, v: number, canWrite = true) => {
    s.sync.onHostSnapshot(v, canWrite, 0, 1);
    s.sync.onReducerCommit(false);
  };

  it("clears a buffered pre-reject payload so the next drain does not replay it", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1); // seeded + writable
    s.type("a"); // posts at v1, editInFlight = true, buffered = null
    s.type("ab"); // in-flight → buffered = "ab"
    expect(s.posted.length).toBe(1);
    s.sync.discardBuffer(); // drop the buffered "ab"
    // A subsequent drain (production: edit-rejected → serialize-error →
    // onReducerCommit) must NOT replay. We model the drain by simulating
    // the production order: the reject puts the gate down first so the
    // first drain is gated, then local-edit-attempt opens it.
    s.sync.onReducerCommit(false); // gate is open in this fake (no canPost block)
    expect(s.posted.length).toBe(1); // no replay — buffer was discarded
  });

  it("is a no-op when no buffer is held (idempotent)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.sync.discardBuffer(); // no buffer at all
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(0);
  });

  it("does not clear editInFlight", () => {
    // Discarding the buffer must NOT clear editInFlight — the host still
    // has a real in-flight Edit pending. The next ack remains the only
    // legitimate trigger for clearing the flag. We pin this by verifying
    // that after discard, a NEW local change while editInFlight is still
    // true falls into the buffer arm (re-fills it) rather than posting.
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a"); // posts at v1, editInFlight = true
    expect(s.posted.length).toBe(1);
    s.sync.discardBuffer();
    s.type("ab"); // editInFlight still true → buffered = "ab", no post
    expect(s.posted.length).toBe(1);
    // Ack drains the buffer to prove editInFlight was never falsely cleared
    // (an early-cleared flag would have let trySend post "ab" above).
    ack(s, 2);
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });
});

describe("cm edit-sync — flush (teardown)", () => {
  it("posts the pending debounced content immediately", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "seed+edit";
      sync.onLocalChange(); // schedules the 300ms timer (pending, not fired)
      expect(posted.length).toBe(0);
      sync.flush(); // teardown: fire it NOW, before the debounce elapses
      expect(posted).toEqual([{ content: "seed+edit", baseDocVersion: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when no debounce is pending", () => {
    vi.useFakeTimers();
    try {
      const doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      sync.flush(); // nothing typed → nothing pending
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-posts the latest even while an Edit is in flight, and RETAINS the buffer for ack-replay", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "a";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // first Edit posts, editInFlight = true
      expect(posted.length).toBe(1);
      doc = "ab";
      sync.onLocalChange(); // schedules a timer while in flight
      sync.flush(); // teardown: FORCE-post the latest even though in flight
      expect(posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 },
      ]);
      // Buffer is RETAINED (not nulled) because an Edit was in flight: the
      // force-post can be stale-rejected in the host settlement→ack window
      // (write lock already released → the lock-held stash path is missed →
      // `stale` verdict), so the bytes must survive for the next ack to replay.
      // Double delivery is idempotent at the host (no-op verdict on content
      // equality).
      sync.onReducerCommit(false);
      expect(posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 }, // replay from the retained buffer
      ]);
      // EXACTLY ONE replay, never a loop: replayIfNeeded nulls the buffer on its
      // own post, so a SECOND commit must NOT post again. Pins the invariant the
      // comments promise (a mutation of replayIfNeeded's self-null would grow
      // `posted` here). Revert-check: replayIfNeeded `buffered = null` →
      // `buffered = content` makes this assertion red.
      sync.onReducerCommit(false);
      expect(posted.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retain the buffer when the force-post had no Edit in flight (accepted → host is authority)", () => {
    // Codex + error-handler review 2026-07-17: retaining unconditionally lets a
    // force-post that the host ACCEPTS outright (no prior in-flight Edit → base
    // matches → `accept`) leave a buffer holding already-applied bytes. A later
    // ack (e.g. after a racing external edit advanced the version) would replay
    // those stale bytes and clobber the external change — the host has no
    // client-side conflict guard for a post-settlement replay. So retention is
    // gated on there having been an Edit in flight; the not-in-flight force-post
    // nulls the buffer like trySend's idle post.
    //
    // Revert-check: change flush's ok arm to `buffered = content` (unconditional)
    // → this test goes red (the replay reposts "seed+edit" a second time).
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "seed+edit";
      sync.onLocalChange(); // timer pending, NO Edit in flight (editInFlight false)
      sync.flush(); // force-posts once; nothing was in flight → buffer nulled
      expect(posted).toEqual([{ content: "seed+edit", baseDocVersion: 1 }]);
      // A later ack must NOT replay the already-posted bytes (buffer was nulled).
      sync.onReducerCommit(false);
      expect(posted.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the buffer on force-post so a stale settlement→ack-window post survives via replay", () => {
    // The bug (Fable review 2026-07-17): flush() force-posts the pending bytes
    // with the CURRENT (stale) docVersion. If an Edit was in flight and the
    // host had ALREADY settled it (write lock released, ack still in transit),
    // the force-posted Edit misses the host's lock-held stash path
    // (host-session-core `case "edit"` only stashes while the lock is held) and
    // hits the `stale` verdict (edit-decision) → the host reposts the
    // authoritative Document and the typed bytes are visibly erased. Nulling
    // the buffer on force-post left NOTHING to replay. Fix: retain the buffer;
    // the normal ack→replay drains it at the fresh docVersion.
    //
    // Revert-check: restore `buffered = null` in flush's ok arm → red (the
    // replay at v2 never fires, "ab" is lost).
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "a";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // edit #1 posts at v1, editInFlight = true
      expect(posted.length).toBe(1);
      // Type one more char inside the debounce window, then hide (alive tab
      // switch) — flush force-posts it at the STALE v1.
      doc = "ab";
      sync.onLocalChange();
      sync.flush();
      expect(posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 }, // force-posted at stale v1
      ]);
      // Host had already settled edit #1 (now at v2) → the force-posted
      // {ab, v1} is stale → host reposts the authoritative Document at v2. The
      // webview processes it: snapshot advances the version, the commit clears
      // in-flight and REPLAYS the retained buffer at the fresh v2 — the bytes
      // the stale force-post could not deliver.
      sync.onHostSnapshot(2, true, 0, 1);
      sync.onReducerCommit(false);
      expect(posted).toContainEqual({ content: "ab", baseDocVersion: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-posts a buffer held while in-flight even with no pending timer", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "a";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // edit #1 posts, editInFlight = true
      doc = "ab";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // trySend buffers "ab" (in flight), timer = null
      expect(posted.length).toBe(1);
      sync.flush(); // no timer, but a buffer is held → force-post it
      expect(posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush with no prior in-flight edit sets editInFlight, preventing a double-post on the next change", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "a";
      sync.onLocalChange(); // timer pending, editInFlight still false
      sync.flush(); // force-posts "a" AND must set editInFlight
      expect(posted).toEqual([{ content: "a", baseDocVersion: 1 }]);
      doc = "ab";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // editInFlight true → must BUFFER, not post
      expect(posted.length).toBe(1);
      sync.onReducerCommit(false); // ack → now it drains
      expect(posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the buffer when the force-post fails (postMessage threw)", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      let allow = true;
      const posted: string[] = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content) => {
          if (!allow) {
            return false;
          }
          posted.push(content);
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "a";
      sync.onLocalChange();
      allow = false;
      sync.flush(); // post fails → buffer retained, editInFlight NOT set
      expect(posted).toEqual([]);
      allow = true;
      sync.onReducerCommit(false); // drains the retained buffer
      expect(posted).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acksInFlightEdit recognises the force-posted content after an idle flush (alive hide→show)", () => {
    // flush()'s success branch records the force-posted bytes as the in-flight
    // holder so a subsequent ok-ack that echoes them is recognised as an echo
    // (and folded by applyDocument) rather than reseeding backwards — the same
    // protection trySend/replayIfNeeded give, but reached through the
    // teardown/hide path.
    // Revert-check: delete `inFlight = stampHeld(content);` from flush's ok
    // branch → this test goes red (acksInFlightEdit returns false).
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const sync = createEditSync({
        getDoc: () => doc,
        post: () => true,
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "seed+edit";
      sync.onLocalChange(); // timer pending, idle (no prior in-flight)
      sync.flush(); // force-posts "seed+edit"; must record it as in-flight
      expect(sync.acksInFlightEdit("seed+edit", 0, 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush under readonly drops the in-window change (no post)", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: string[] = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content) => {
          posted.push(content);
          return true;
        },
      });
      sync.onHostSnapshot(1, false, 0, 1); // readonly
      doc = "a";
      sync.onLocalChange();
      sync.flush();
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cm edit-sync — flushIfIdle", () => {
  it("posts the in-window keystroke when idle", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
        // No scheduleFlush override → real setTimeout path so the timer stays
        // pending until we call flushIfIdle.
      });
      sync.onHostSnapshot(1, true, 0, 1);
      doc = "seed+typed";
      sync.onLocalChange(); // schedules the 300ms timer (pending, not fired)
      expect(posted.length).toBe(0); // debounce window — not posted yet
      sync.flushIfIdle(); // mid-session flush: timer pending, idle (no in-flight)
      expect(posted).toEqual([{ content: "seed+typed", baseDocVersion: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers (does NOT double-post) when an Edit is already in flight", () => {
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      // First edit: let the timer fire so the Edit is in flight.
      doc = "a";
      sync.onLocalChange();
      vi.advanceTimersByTime(300); // fires trySend → posts, editInFlight = true
      expect(posted.length).toBe(1);
      // Second keystroke inside the debounce window (timer pending, in flight).
      doc = "ab";
      sync.onLocalChange(); // schedules a new timer while in flight
      // flushIfIdle: timer is pending → clears it and calls trySend, but
      // trySend RESPECTS single-flight → buffers "ab", does NOT post again.
      sync.flushIfIdle();
      expect(posted.length).toBe(1); // no second post at the same version
      // Deliver the ack: the buffered content must replay (no data loss).
      sync.onHostSnapshot(2, true, 0, 1);
      sync.onReducerCommit(false); // ack clears in-flight + drains
      expect(posted.length).toBe(2);
      expect(posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when nothing was typed in the debounce window", () => {
    vi.useFakeTimers();
    try {
      const doc = "seed";
      const posted: Array<{ content: string; baseDocVersion: number }> = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content, baseDocVersion) => {
          posted.push({ content, baseDocVersion });
          return true;
        },
      });
      sync.onHostSnapshot(1, true, 0, 1);
      // No onLocalChange call → no pending timer.
      sync.flushIfIdle(); // nothing pending → must be a no-op
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// onHostSnapshot captures (externalEpoch, epochGeneration) alongside the
// version; S3b's buffer-validity + acceptance logic consumes it (the behaviour
// tests live in the S3b block below). These pins keep the RECORDING contract
// honest — what recordedIdentity() returns after each snapshot.
describe("cm edit-sync — recordedIdentity", () => {
  it("starts null before the first snapshot", () => {
    const s = setup();
    expect(s.sync.recordedIdentity()).toEqual({ epoch: null, generation: null });
  });

  it("records the pair from an accepted host snapshot", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 3, 12345);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 3, generation: 12345 });
  });

  it("updates the recorded pair on each accepted snapshot", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 999);
    s.sync.onHostSnapshot(2, true, 1, 999);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 1, generation: 999 });
  });

  it("does NOT update the recorded pair on a stale (older-version) SAME-generation snapshot", () => {
    // Stale ordering only holds WITHIN one host generation (S3b). A lower
    // version under the SAME generation is ignored wholesale; the recorded pair
    // is unchanged. (A DIFFERENT-generation lower version is an identity
    // transition and IS adopted — covered by the S3b acceptance tests.)
    const s = setup();
    s.sync.onHostSnapshot(5, true, 4, 777);
    s.sync.onHostSnapshot(3, true, 2, 777); // stale, same generation — ignored
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 4, generation: 777 });
  });
});

// S3b: epoch-bounded buffer validity + generation-aware acceptance ordering +
// the clustering escalation tripwire. The buffer becomes {content, epoch,
// generation}; replayIfNeeded DROPS it on a same-generation foreign epoch
// advance or ANY identity transition; onHostSnapshot adopts a transitioned
// identity unconditionally (bypassing the stale-version guard); ≥3 transitions
// within 5 minutes fire ONE per-session notice. Repro map (a)–(h) from the plan.
describe("cm edit-sync — epoch-bounded buffers (S3b)", () => {
  // Snapshot + drain with an identity pair, mirroring production's
  // onHostSnapshot → onReducerCommit(false) ack sequence.
  const ackPair = (
    s: ReturnType<typeof setup>,
    v: number,
    epoch: number,
    generation: number,
    canWrite = true
  ) => {
    s.sync.onHostSnapshot(v, canWrite, epoch, generation);
    s.sync.onReducerCommit(false);
  };

  it("(a/b) drops a single-flight buffer when a settlement Document carries a higher epoch", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts at v1, editInFlight, buffered=null
    s.type("ab"); // buffered, stamped {epoch:0, gen:42}
    expect(s.posted.length).toBe(1);
    // External-wins settlement: same generation, epoch advanced 0→1. The webview
    // mirrors the host's external-wins policy — the buffer is DROPPED, not
    // replayed over the foreign bytes.
    ackPair(s, 2, 1, 42);
    expect(s.posted.length).toBe(1); // no replay post
  });

  // Also the RECEIVING-side pin for host-session-core's `settlementTransitionFailed`
  // recovery: that arm posts a same-epoch Document precisely so this replay
  // happens, which is what keeps a dropped stash from being a data loss on the
  // alive path (see .claude/docs/LEARNING.md 2026-09-11). Deleting this test
  // leaves that claim unverified — re-home it rather than dropping it.
  it("(h) replays a buffer on a same-generation, same-epoch settlement (stale-recovery preserved)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 5, 42);
    s.type("a"); // posts at v1, in flight
    s.type("ab"); // buffered {epoch:5, gen:42}
    expect(s.posted.length).toBe(1);
    // No foreign bytes: the settlement epoch is UNCHANGED → the recovery replay
    // fires (this is the case byte-heuristics alone could not separate from
    // external-wins).
    ackPair(s, 2, 5, 42);
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });

  it("(c) drops a buffer captured pre-readonly-flip when foreign edits advance the epoch", () => {
    const s = setup();
    s.sync.onHostSnapshot(2, true, 0, 42);
    s.type("a"); // posts at v2, in flight
    s.type("ab"); // buffered {epoch:0, gen:42}, typed while writable
    expect(s.posted.length).toBe(1);
    // Foreign edits arrive during a readonly window: epoch advances 0→1 under
    // canWrite=false. The foreign-epoch drop fires ahead of the readonly hold.
    ackPair(s, 3, 1, 42, false);
    // Write re-granted at the advanced epoch: nothing to replay (dropped).
    ackPair(s, 3, 1, 42, true);
    expect(s.posted.length).toBe(1);
  });

  it("(d1) drops a buffer on a new-generation Document (cross-restart hole)", () => {
    const s = setup();
    s.sync.onHostSnapshot(5, true, 3, 111);
    s.type("a"); // posts at v5, in flight
    s.type("ab"); // buffered {epoch:3, gen:111}
    expect(s.posted.length).toBe(1);
    // A new host session (generation 222) at epoch 0, LOWER version — an identity
    // transition. Adopted unconditionally; the cross-generation buffer dropped.
    ackPair(s, 1, 0, 222);
    expect(s.posted.length).toBe(1); // dropped, not replayed
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 222 });
    // Not deaf: a fresh keystroke posts at the ADOPTED (lower) version.
    s.type("fresh");
    expect(s.posted[1]).toEqual({ content: "fresh", baseDocVersion: 1 });
  });

  it("(e/f) adopts lower-version different-generation Documents (bypasses the stale guard)", () => {
    const s = setup();
    // Session A leaves the webview at a HIGH version.
    s.sync.onHostSnapshot(10, true, 0, 111);
    // Session B seeds at a LOWER version — normally stale-dropped, but a new
    // generation is an identity transition → adopted.
    s.sync.onHostSnapshot(5, true, 0, 222);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 222 });
    s.sync.onReducerCommit(false);
    s.type("x");
    expect(s.posted[s.posted.length - 1]).toEqual({ content: "x", baseDocVersion: 5 });
  });

  it("(f) A→B→A straggler self-heals: never deaf, typing survives the re-adoption", () => {
    const s = setup();
    s.sync.onHostSnapshot(10, true, 0, 111); // A at v10
    s.sync.onHostSnapshot(5, true, 0, 222); // B adopted (transition)
    // A delayed straggler from generation 111 arrives AFTER B — transition, adopted.
    s.sync.onHostSnapshot(11, true, 3, 111);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 3, generation: 111 });
    // The live host B re-adopts at a LOWER version than the straggler — transition.
    s.sync.onHostSnapshot(6, true, 1, 222);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 1, generation: 222 });
    s.sync.onReducerCommit(false);
    s.type("survives");
    expect(s.posted[s.posted.length - 1]).toEqual({ content: "survives", baseDocVersion: 6 });
  });

  it("(g) fires the resync-storm notice EXACTLY ONCE at ≥3 transitions in the window", () => {
    let clock = 1000;
    const onResyncStorm = vi.fn();
    const s = setup({ now: () => clock, onResyncStorm });
    s.sync.onHostSnapshot(1, true, 0, 1); // seed — NOT a transition
    expect(onResyncStorm).not.toHaveBeenCalled();
    clock += 1000;
    s.sync.onHostSnapshot(1, true, 0, 2); // transition 1
    clock += 1000;
    s.sync.onHostSnapshot(1, true, 0, 3); // transition 2
    expect(onResyncStorm).not.toHaveBeenCalled();
    clock += 1000;
    s.sync.onHostSnapshot(1, true, 0, 4); // transition 3 → fires
    expect(onResyncStorm).toHaveBeenCalledTimes(1);
    clock += 1000;
    s.sync.onHostSnapshot(1, true, 0, 5); // transition 4 → latched, no re-fire
    expect(onResyncStorm).toHaveBeenCalledTimes(1);
  });

  it("(g) a single transition fires NO notice", () => {
    const onResyncStorm = vi.fn();
    const s = setup({ now: () => 0, onResyncStorm });
    s.sync.onHostSnapshot(1, true, 0, 1); // seed
    s.sync.onHostSnapshot(1, true, 0, 2); // one transition
    expect(onResyncStorm).not.toHaveBeenCalled();
  });

  it("(g) transitions spread beyond the 5-minute window do NOT fire the notice", () => {
    let clock = 0;
    const onResyncStorm = vi.fn();
    const s = setup({ now: () => clock, onResyncStorm });
    const SIX_MIN = 6 * 60 * 1000;
    s.sync.onHostSnapshot(1, true, 0, 1); // seed
    s.sync.onHostSnapshot(1, true, 0, 2); // transition 1 @ t=0
    clock += SIX_MIN;
    s.sync.onHostSnapshot(1, true, 0, 3); // transition 2 @ t=6min (window evicts #1)
    clock += SIX_MIN;
    s.sync.onHostSnapshot(1, true, 0, 4); // transition 3 @ t=12min
    expect(onResyncStorm).not.toHaveBeenCalled();
  });

  it("(g) a THROWING storm notifier does not abort the identity adoption", () => {
    // The storm notice fires from onHostSnapshot BEFORE the incoming version /
    // canWrite / seeded / recorded pair are adopted, so an escaping throw would
    // strand `recorded` a generation behind — and the very next drain would then
    // find the held buffer's stamp still matching, replay it over the foreign
    // bytes, and say nothing. It would also escape into host.ts's unguarded
    // message handler. Hence the local catch, and hence the two assertions that
    // look past "it did not throw": the pair was adopted, and the drain drops.
    let clock = 1000;
    const onResyncStorm = vi.fn(() => {
      throw new Error("storm notice failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Silences the stale-buffer drop trace only — that path has its own tests.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup({ now: () => clock, onResyncStorm });
      s.sync.onHostSnapshot(1, true, 0, 1); // seed — not a transition
      clock += 1000;
      s.sync.onHostSnapshot(1, true, 0, 2); // transition 1
      clock += 1000;
      s.sync.onHostSnapshot(1, true, 0, 3); // transition 2
      s.type("a"); // posts at v1 — in flight
      s.type("ab"); // buffered, stamped {epoch: 0, generation: 3}
      s.setDoc("foreign"); // the reseed production performs before the drain
      clock += 1000;
      // Transition 3 → the latched notice fires and throws.
      expect(() => s.sync.onHostSnapshot(2, true, 0, 4)).not.toThrow();
      expect(onResyncStorm).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[quoll] onResyncStorm threw", expect.any(Error));
      // The adoption completed despite the throw — this is the assertion that
      // makes the test more than a try/catch smoke test.
      expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 4 });
      // ...so the drain judges the buffer against the NEW pair and drops it
      // instead of replaying "ab" over the foreign bytes.
      s.sync.onReducerCommit(false);
      expect(s.posted.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("isIdentityTransition is a pure predicate (no side effects, agrees across calls)", () => {
    const onResyncStorm = vi.fn();
    const s = setup({ onResyncStorm });
    s.sync.onHostSnapshot(1, true, 0, 111);
    // Repeated pure queries must not count toward the tripwire nor mutate state.
    for (let i = 0; i < 5; i++) {
      expect(s.sync.isIdentityTransition(0, 222)).toBe(true); // new generation
      expect(s.sync.isIdentityTransition(9, 111)).toBe(false); // same generation
    }
    expect(onResyncStorm).not.toHaveBeenCalled();
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 111 });
  });

  it("treats the first snapshot as an adoption, not a transition (no tripwire count)", () => {
    const s = setup();
    expect(s.sync.isIdentityTransition(0, 111)).toBe(false); // before any snapshot
  });

  // The buffer drop above THROWS AWAY bytes the user typed, and its only record
  // used to be a console.warn — a webview devtools console is not a signal a
  // normal user can see. `onLocalEditDiscarded` is the user-visible counterpart,
  // fired only when that discard was a real LOSS: the authoritative document does
  // not carry the NEWEST held bytes. There is no drop → notice bijection — the
  // drop is unconditional, the notice is not — so these tests pin WHEN it fires,
  // when it deliberately STAYS SILENT, and — just as importantly — that a
  // misbehaving notifier cannot corrupt the drain it is called from. The shell
  // renders a notice from it.
  it("fires onLocalEditDiscarded exactly once when a foreign epoch advance drops the buffer", () => {
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts at v1, in flight
    s.type("ab"); // buffered, stamped {epoch:0, gen:42}
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
    // Model production: applyDocument reseeds the view to the host's bytes
    // BEFORE the reducer commit drains. Leaving the doc at "ab" would assert a
    // state production cannot reach — and one the loss rule correctly reads as
    // "nothing lost", since the document would be carrying the buffered bytes.
    s.setDoc("external");
    ackPair(s, 2, 1, 42); // same generation, epoch 0→1 → foreign bytes won
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    expect(s.posted.length).toBe(1); // dropped, not replayed
  });

  it("does NOT fire onLocalEditDiscarded when the buffer survives and replays", () => {
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 5, 42);
    s.type("a");
    s.type("ab");
    ackPair(s, 2, 5, 42); // same generation, SAME epoch → replay
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
    expect(s.posted.length).toBe(2);
  });

  it("does NOT fire onLocalEditDiscarded on an identity transition with no buffer held", () => {
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    ackPair(s, 1, 0, 43); // transition, but nothing was buffered
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("a THROWING notifier neither escapes the drain nor strands the dropped buffer", () => {
    // The notifier is a DISPLAY-side side effect wired by the shell, and a DOM
    // failure in it must not reach the sync loop. This test owns the CATCH half
    // only: the throw does not propagate into the caller (production's caller is
    // the shell's dispatch chain) and it is logged rather than swallowed
    // silently. The ORDERING half (call after `buffered = null`) is owned by the
    // re-entrancy test below — with the catch present, a throw cannot strand the
    // buffer from either position, so this test cannot discriminate order.
    const onLocalEditDiscarded = vi.fn(() => {
      throw new Error("notice failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a");
    s.type("ab");
    s.setDoc("external"); // the reseed production always performs first
    expect(() => ackPair(s, 2, 1, 42)).not.toThrow();
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    // Second drain: nothing left to drop → no second notice.
    s.sync.onReducerCommit(false);
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    expect(s.posted.length).toBe(1);
    errorSpy.mockRestore();
  });

  it("a RE-ENTRANT notifier fires exactly once for one dropped buffer", () => {
    // A notifier that synchronously re-enters the drain (the shell's dispatch
    // wrapper can do this) must not see the same buffer twice. THIS is the test
    // that owns the call-after-drop ordering: move the call above
    // `buffered = null` and the re-entrant drain finds the buffer still held.
    //
    // The notifier must re-enter the SAME instance it belongs to, which is why
    // `target` is a mutable binding assigned right after `setup` returns rather
    // than a second `setup()` call.
    let target: ReturnType<typeof setup> | null = null;
    let calls = 0;
    const s = setup({
      onLocalEditDiscarded: () => {
        calls++;
        if (calls === 1) {
          target?.sync.onReducerCommit(false); // re-enter the drain mid-notice
        }
      },
    });
    target = s;
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a");
    s.type("ab");
    s.setDoc("external"); // the reseed production always performs first
    ackPair(s, 2, 1, 42);
    expect(calls).toBe(1);
    expect(s.posted.length).toBe(1);
  });

  // The SECOND holder of un-acked local bytes: the Edit already posted and
  // awaiting its ack. `buffered` is null on this path (the debounce fired to
  // post, so cancelPendingFlush captures nothing), so the drop arm never runs —
  // this was silent before. The subject the rule judges is the NEWEST held
  // content, so these tests drive both the in-flight-only case and the case
  // where a newer buffer makes an older posted snapshot irrelevant.
  it("fires onLocalEditDiscarded once when a foreign epoch advance discards the in-flight Edit", () => {
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts at v1, in flight; nothing buffered
    s.setDoc("foreign"); // reseeded: the host's bytes are not ours
    ackPair(s, 2, 1, 42);
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    expect(s.posted.length).toBe(1); // nothing left to replay
  });

  it("does NOT fire onLocalEditDiscarded when the authoritative document carries our in-flight bytes", () => {
    // The byte-identical foreign write, and the host-restart-after-apply case:
    // the lineage moved on, but the document still holds what we posted, so the
    // notice would be a false alarm.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts "a"
    ackPair(s, 2, 1, 42); // epoch advanced; getDoc() is still "a"
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("does NOT fire onLocalEditDiscarded on an EOL-only difference", () => {
    // The host canonicalises a Document to document.eol while the webview posts
    // its own document-EOL bytes, so an EOL-only skew is routine — not a loss.
    // Mirrors the host's own EOL-insensitive contentMatches.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a\nb"); // posts LF bytes
    s.setDoc("a\r\nb"); // the host came back CRLF at a new epoch
    ackPair(s, 2, 1, 42);
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("does NOT fire onLocalEditDiscarded when a Document carries the force-posted bytes", () => {
    // flush() posts even while an Edit is in flight and RETAINS the buffer, so
    // both holders end up holding the same bytes under a stale stamp. A foreign
    // Document that happens to carry exactly those bytes costs the user nothing:
    // the buffer is still dropped (it must be), but there is nothing to report.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts "a" — in flight
    s.type("ab"); // buffered "ab"
    s.sync.flush(); // force-posts "ab", retains the buffer (in-flight contention)
    ackPair(s, 2, 1, 42); // epoch advanced; getDoc() is "ab" — exactly what we hold
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("does NOT fire onLocalEditDiscarded when a NEWER buffer survives an older in-flight snapshot", () => {
    // The false positive a per-holder disjunction produces, and the reason the
    // rule has ONE subject. The buffer is the newer snapshot, so when the host is
    // holding its bytes the user has nothing to reapply — whatever became of the
    // older posted snapshot.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts "a" — in flight
    s.type("ab"); // buffered "ab" — the newest local bytes
    s.setDoc("ab"); // the foreign write landed exactly the user's latest bytes
    ackPair(s, 2, 1, 42); // epoch advanced → buffer dropped, but nothing lost
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("does NOT fire onLocalEditDiscarded on a SAME-LINEAGE Document that differs from the held bytes", () => {
    // Content mismatch WITHOUT supersession — a same-epoch authoritative repost.
    // The lineage did not move, so the claim this notice makes is not in
    // evidence. This is the pin that keeps the lineage conjunct honest: without
    // it, every ordinary repost would notify.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts "a" — in flight
    s.setDoc("host-side-other"); // reposted content, SAME epoch and generation
    ackPair(s, 2, 0, 42);
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("does NOT fire onLocalEditDiscarded on a same-lineage ack while the doc is ahead", () => {
    // The everyday shape: the user kept typing THROUGH the in-flight window, so
    // by the time our own ack lands the live doc has moved past the bytes we
    // posted. Deliberately rests on ONE conjunct so it can fail: the lineage
    // conjunct is FALSE while the "document does not carry our bytes" conjunct
    // is TRUE, so dropping the lineage test alone turns this red. (An earlier
    // version acked with the doc still equal to the posted bytes, making BOTH
    // conjuncts false: it read as a negative pin while being unable to fail under
    // any single-conjunct regression.)
    // Role split, so the three same-lineage silences stay distinguishable: the
    // test above drives FOREIGN repost bytes at the unit level, this one drives
    // OUR OWN newer descendant bytes, and the real-seam pins live in
    // shell.test.ts / editor.test.ts ("reposts different bytes on the SAME
    // lineage") because the regression's symptom is a spurious user notice.
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a");
    s.setDoc("ab"); // typed during the in-flight window
    ackPair(s, 2, 0, 42); // same lineage — our ack
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
  });

  it("fires on an identity transition that did not carry the in-flight bytes, not on one that did", () => {
    const lost = vi.fn();
    const s1 = setup({ onLocalEditDiscarded: lost });
    s1.sync.onHostSnapshot(1, true, 0, 42);
    s1.type("a");
    s1.setDoc("fresh-host-doc"); // new generation, content not ours
    ackPair(s1, 1, 0, 43);
    expect(lost).toHaveBeenCalledTimes(1);

    const kept = vi.fn();
    const s2 = setup({ onLocalEditDiscarded: kept });
    s2.sync.onHostSnapshot(1, true, 0, 42);
    s2.type("a"); // host applied "a", then restarted
    ackPair(s2, 1, 0, 43); // new generation, content IS ours
    expect(kept).not.toHaveBeenCalled();
  });

  it("a THROWING notifier on the in-flight path neither escapes the drain nor re-fires", () => {
    const onLocalEditDiscarded = vi.fn(() => {
      throw new Error("notice failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ onLocalEditDiscarded });
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a");
    s.setDoc("foreign");
    expect(() => ackPair(s, 2, 1, 42)).not.toThrow();
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    // The holder is settled, not re-announced, and the sync loop still works.
    s.sync.onReducerCommit(false);
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    s.type("foreign+");
    expect(s.posted.length).toBe(2);
    errorSpy.mockRestore();
  });

  it("a RE-ENTRANT notifier on the in-flight path fires exactly once", () => {
    let target: ReturnType<typeof setup> | null = null;
    let calls = 0;
    const s = setup({
      onLocalEditDiscarded: () => {
        calls++;
        if (calls === 1) {
          target?.sync.onReducerCommit(false); // re-enter the drain mid-notice
        }
      },
    });
    target = s;
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a");
    s.setDoc("foreign");
    ackPair(s, 2, 1, 42);
    expect(calls).toBe(1);
  });
});

// A readonly hard drop is the one outcome in this module that DISCARDS the
// user's bytes rather than deferring their replay, so all three sites must
// leave a trace — the same contract the stale-buffer drop in replayIfNeeded
// already honours. Each test drives the site through its production entry
// point and asserts the warn fired without the document text in the payload
// (a drop trace must never become a content leak).
describe("cm edit-sync — readonly hard drops are traced", () => {
  const SECRET = "SECRET-BYTES"; // 12 chars — distinctive enough to grep the payload for
  type WarnSpy = MockInstance<typeof console.warn>;
  const warnArgs = (spy: WarnSpy) =>
    spy.mock.calls.filter((c) => String(c[0]).includes("under readonly"));
  const expectNoContentLeak = (spy: WarnSpy) => {
    expect(JSON.stringify(warnArgs(spy))).not.toContain(SECRET);
  };

  it("warns when trySend hard-drops a change typed under readonly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, false, 0, 1); // readonly
      s.type(SECRET);
      expect(s.posted).toEqual([]);
      expect(warnArgs(warn)).toEqual([
        [
          expect.stringContaining("under readonly"),
          { site: "trySend", liveLength: SECRET.length, bufferedLength: null },
        ],
      ]);
      expectNoContentLeak(warn);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when cancelPendingFlush hard-drops the in-window keystroke", () => {
    // The real timer path (no scheduleFlush override) is required: the capture
    // branch only runs while a debounce timer is live.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let doc = "seed";
      const sync = createEditSync({ getDoc: () => doc, post: () => true });
      sync.onHostSnapshot(1, false, 0, 1); // readonly
      doc = SECRET;
      sync.onLocalChange(); // schedules the flush; still inside the window
      sync.cancelPendingFlush(); // host Document interrupts → readonly hard drop
      expect(warnArgs(warn)).toEqual([
        [
          expect.stringContaining("under readonly"),
          { site: "cancelPendingFlush", liveLength: SECRET.length, bufferedLength: null },
        ],
      ]);
      expectNoContentLeak(warn);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("warns when flush hard-drops pending bytes at teardown under readonly", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let doc = "seed";
      const posted: string[] = [];
      const sync = createEditSync({
        getDoc: () => doc,
        post: (content) => {
          posted.push(content);
          return true;
        },
      });
      sync.onHostSnapshot(1, false, 0, 1); // readonly
      doc = SECRET;
      sync.onLocalChange();
      sync.flush();
      expect(posted).toEqual([]);
      expect(warnArgs(warn)).toEqual([
        [
          expect.stringContaining("under readonly"),
          { site: "flush", liveLength: SECRET.length, bufferedLength: null },
        ],
      ]);
      expectNoContentLeak(warn);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays silent when nothing is pending — a no-op flush is not a drop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, false, 0, 1); // readonly, nothing typed
      s.sync.flush(); // content === null → genuine no-op
      s.sync.cancelPendingFlush(); // no live timer → no capture, no drop
      expect(warnArgs(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when a normal writable edit is posted (not a drop)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 1); // writable
      s.type(SECRET);
      expect(s.posted).toEqual([{ content: SECRET, baseDocVersion: 1 }]);
      expect(warnArgs(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports liveLength and bufferedLength as DISTINCT values when a buffer survives a readonly reseed", () => {
    // A buffer stashed under single-flight survives a readonly Document because
    // replayIfNeeded's `!canWrite` guard returns WITHOUT nulling it — so by the
    // time a further readonly change hits trySend's drop branch, the RETAINED
    // buffer and the dropped live doc disagree. The two lengths mean different
    // things (what was dropped vs what is still held for a re-grant), so picking
    // one via `??` would hide the other; this pins that both are reported, and
    // that they are genuinely different numbers (not a coincidental match).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 1); // seed, writable
      s.type("aa"); // posts "aa" at v1, editInFlight = true
      s.type("aaa"); // single-flight: stashed into buffered (len 3), not posted
      expect(s.posted.length).toBe(1);
      s.sync.onHostSnapshot(2, false, 0, 1); // readonly ack; canWrite flips false
      s.sync.onReducerCommit(false); // editInFlight clears; replayIfNeeded holds
      // the buffer under !canWrite WITHOUT nulling it (buffered is still "aaa")
      s.type("aaaaa"); // trySend's readonly branch fires: doc is now "aaaaa" (len 5)
      expect(s.posted.length).toBe(1); // no new post — still a hard drop
      expect(warnArgs(warn)).toEqual([
        [
          expect.stringContaining("under readonly"),
          { site: "trySend", liveLength: 5, bufferedLength: 3 },
        ],
      ]);
      expectNoContentLeak(warn);
    } finally {
      warn.mockRestore();
    }
  });
});

// Bytes typed while the document was WRITABLE and never applied by the host are
// the one thing a readonly flip must not destroy: they sit in the replay buffer,
// the drain holds them under `!canWrite`, and a re-grant replays them. The three
// readonly arms (trySend / cancelPendingFlush / flush) drop only the LIVE change
// — a docChanged under readonly is programmatic — and leave that buffer alone.
// `flush` additionally tells the user that edits are being held — asking the
// notifier on each call until it reports the notice shown, then staying quiet
// for the rest of the readonly episode.
//
// THE STUB HAS NO VIEW. Production's `canWrite: false` Document reseeds the view
// to the HOST's content, so after the flip the held bytes are no longer on
// screen; `setup()`'s getDoc() keeps returning the last typed value instead.
// `readonlyAck` models the reseed — without it the already-carried skip would
// (correctly) stay silent and a notifying test would assert the wrong thing.
describe("cm edit-sync — a writable-era buffer survives readonly", () => {
  const readonlyAck = (s: ReturnType<typeof setup>, v: number, hostContent: string) => {
    s.sync.onHostSnapshot(v, false, 0, 1);
    s.sync.onReducerCommit(false);
    s.setDoc(hostContent); // the readonly reseed
  };
  const regrant = (s: ReturnType<typeof setup>, v: number) => {
    s.sync.onHostSnapshot(v, true, 0, 1);
    s.sync.onReducerCommit(false);
  };
  // Post "a" (in flight), then buffer "ab" under single-flight — both writable.
  const holdAb = (s: ReturnType<typeof setup>) => {
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("a");
    s.type("ab");
    expect(s.posted).toEqual([{ content: "a", baseDocVersion: 1 }]);
  };
  // The real debounce path (no scheduleFlush override): the only way to hold a
  // LIVE timer, which the cancelPendingFlush and flush-with-timer arms need.
  const timerSetup = (opts?: { onReadonlyHold?: () => boolean }) => {
    let doc = "";
    const posted: Posted[] = [];
    const sync = createEditSync({
      getDoc: () => doc,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
      onReadonlyHold: opts?.onReadonlyHold,
    });
    return {
      sync,
      posted,
      setDoc: (next: string) => {
        doc = next;
      },
      // A local change left INSIDE the debounce window (timer live).
      change: (next: string) => {
        doc = next;
        sync.onLocalChange();
      },
    };
  };
  // Post "a" (in flight) and buffer "ab", then flip readonly — the timer is idle.
  const timerHoldAbThenReadonly = (t: ReturnType<typeof timerSetup>) => {
    t.sync.onHostSnapshot(1, true, 0, 1);
    t.change("a");
    vi.advanceTimersByTime(300); // posts "a" — in flight
    t.change("ab");
    vi.advanceTimersByTime(300); // buffers "ab"
    expect(t.posted).toEqual([{ content: "a", baseDocVersion: 1 }]);
    t.sync.onHostSnapshot(2, false, 0, 1);
    t.sync.onReducerCommit(false);
  };

  it("flush under readonly keeps the buffer, and a re-grant replays it", () => {
    const s = setup();
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.flush(); // blur / hide while readonly
    expect(s.posted.length).toBe(1); // nothing posted under readonly
    regrant(s, 2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
    expect(s.posted.length).toBe(2);
  });

  it("notifies exactly once per readonly episode", () => {
    const onReadonlyHold = vi.fn();
    const s = setup({ onReadonlyHold });
    holdAb(s);
    readonlyAck(s, 2, "a");
    expect(onReadonlyHold).not.toHaveBeenCalled(); // the flip itself says nothing
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    s.sync.flush(); // every later blur finds the same held buffer
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    // Write returns: the buffer replays, its ack lands, and the episode is over.
    regrant(s, 2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
    s.setDoc("ab");
    regrant(s, 3);
    // A SECOND episode with a fresh held buffer announces again.
    s.type("abc"); // posts — in flight
    s.type("abcd"); // buffered
    readonlyAck(s, 4, "abc");
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(2);
  });

  it("a readonly repost inside the episode does not re-arm the announcement", () => {
    const onReadonlyHold = vi.fn();
    const s = setup({ onReadonlyHold });
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    // The host reposts while STILL readonly (hidden-webview resync / no-op
    // repost): only a snapshot that grants write ends the episode.
    readonlyAck(s, 2, "a");
    s.sync.flush();
    readonlyAck(s, 3, "a");
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    // ...and the buffer is still held for the re-grant.
    regrant(s, 3);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 3 });
  });

  it("a DECLINED hold is retried on each flush until it is shown, and traced only then", () => {
    // `false` = the notice was not shown (the shell's slot held a stronger
    // claim). Spending the latch on it would end the episode with the hold
    // never drawn.
    const onReadonlyHold = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const holdTraces = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("holding un-posted edits"));
    try {
      const s = setup({ onReadonlyHold });
      holdAb(s);
      readonlyAck(s, 2, "a");
      s.sync.flush();
      expect(onReadonlyHold).toHaveBeenCalledTimes(1);
      s.sync.flush();
      expect(onReadonlyHold).toHaveBeenCalledTimes(2);
      expect(holdTraces()).toEqual([]); // a decline is not an announcement
      s.sync.flush(); // shown this time
      expect(onReadonlyHold).toHaveBeenCalledTimes(3);
      expect(holdTraces()).toEqual([
        [expect.stringContaining("[quoll]"), { heldLength: 2, liveLength: 1 }],
      ]);
      s.sync.flush();
      s.sync.flush();
      expect(onReadonlyHold).toHaveBeenCalledTimes(3); // latched once shown
      expect(holdTraces().length).toBe(1);
      expect(s.posted.length).toBe(1);
      regrant(s, 2);
      expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  it("traces the hold with lengths only — never the held bytes", () => {
    const SECRET = "SECRET-BYTES";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 1);
      s.type("a");
      s.type(SECRET); // buffered
      readonlyAck(s, 2, "a");
      s.sync.flush();
      s.sync.flush();
      const holds = warn.mock.calls.filter((c) => String(c[0]).includes("holding un-posted edits"));
      expect(holds).toEqual([
        [expect.stringContaining("[quoll]"), { heldLength: SECRET.length, liveLength: 1 }],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it("a programmatic change under readonly is dropped silently (sync scheduler)", () => {
    // NEGATIVE PIN: no writable-era buffer exists, so there is nothing to hold.
    const onReadonlyHold = vi.fn();
    const s = setup({ onReadonlyHold });
    s.sync.onHostSnapshot(1, false, 0, 1); // readonly seed
    s.type("x"); // trySend's readonly arm
    s.sync.flush();
    expect(onReadonlyHold).not.toHaveBeenCalled();
    expect(s.posted).toEqual([]);
    regrant(s, 2);
    expect(s.posted).toEqual([]);
  });

  it("a programmatic change under readonly is dropped silently (live debounce timer)", () => {
    // NEGATIVE PIN: flush meets a live timer and no buffer.
    vi.useFakeTimers();
    try {
      const onReadonlyHold = vi.fn();
      const t = timerSetup({ onReadonlyHold });
      t.sync.onHostSnapshot(1, false, 0, 1); // readonly seed
      t.change("x");
      t.sync.flush();
      expect(onReadonlyHold).not.toHaveBeenCalled();
      expect(t.posted).toEqual([]);
      t.sync.onHostSnapshot(2, true, 0, 1);
      t.sync.onReducerCommit(false);
      expect(t.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("trySend's readonly arm drops the live change and keeps the buffer", () => {
    const onReadonlyHold = vi.fn();
    const s = setup({ onReadonlyHold });
    s.sync.onHostSnapshot(1, true, 0, 1);
    s.type("aa"); // posts — in flight
    s.type("aaa"); // buffered while writable
    s.sync.onHostSnapshot(2, false, 0, 1);
    s.sync.onReducerCommit(false);
    s.type("aaaaa"); // programmatic change under readonly → dropped
    expect(s.posted.length).toBe(1);
    regrant(s, 2);
    // The writable-era bytes replay — NOT the readonly-era live doc.
    expect(s.posted[1]).toEqual({ content: "aaa", baseDocVersion: 2 });
    expect(s.posted.length).toBe(2);
    expect(onReadonlyHold).not.toHaveBeenCalled(); // only flush announces
  });

  it("cancelPendingFlush's readonly arm drops the live change and keeps the buffer", () => {
    vi.useFakeTimers();
    try {
      const onReadonlyHold = vi.fn();
      const t = timerSetup({ onReadonlyHold });
      timerHoldAbThenReadonly(t);
      t.change("ZZZ"); // programmatic change under readonly — timer live
      t.sync.cancelPendingFlush(); // a host Document interrupts the window
      t.sync.onHostSnapshot(2, true, 0, 1);
      t.sync.onReducerCommit(false);
      expect(t.posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 2 },
      ]);
      vi.advanceTimersByTime(300); // the cancelled timer must not fire later
      expect(t.posted.some((p) => p.content === "ZZZ")).toBe(false);
      expect(onReadonlyHold).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush with a live readonly timer AND a held buffer drops one and holds the other", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const onReadonlyHold = vi.fn();
      const t = timerSetup({ onReadonlyHold });
      timerHoldAbThenReadonly(t);
      t.change("ZZZ"); // programmatic change under readonly — timer live
      t.sync.flush();
      const drops = warn.mock.calls.filter((c) => String(c[0]).includes("dropping local change"));
      expect(drops).toEqual([
        [
          expect.stringContaining("under readonly"),
          { site: "flush", liveLength: 3, bufferedLength: 2 },
        ],
      ]);
      expect(onReadonlyHold).toHaveBeenCalledTimes(1);
      t.sync.onHostSnapshot(2, true, 0, 1);
      t.sync.onReducerCommit(false);
      expect(t.posted).toEqual([
        { content: "a", baseDocVersion: 1 },
        { content: "ab", baseDocVersion: 2 },
      ]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a foreign epoch advance during the hold still discards the buffer, with its own notice", () => {
    const onReadonlyHold = vi.fn();
    const onLocalEditDiscarded = vi.fn();
    const s = setup({ onReadonlyHold, onLocalEditDiscarded });
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.flush();
    expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    expect(onLocalEditDiscarded).not.toHaveBeenCalled();
    // Foreign bytes land while still readonly: same generation, epoch 0→1.
    s.setDoc("external");
    s.sync.onHostSnapshot(3, false, 1, 1);
    s.sync.onReducerCommit(false);
    expect(onLocalEditDiscarded).toHaveBeenCalledTimes(1);
    s.sync.onHostSnapshot(3, true, 1, 1);
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(1); // nothing left to replay
  });

  it("discardBuffer under readonly leaves nothing to hold or announce", () => {
    // NEGATIVE PIN: the reject-retry discard is unchanged by the hold.
    const onReadonlyHold = vi.fn();
    const s = setup({ onReadonlyHold });
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.discardBuffer();
    s.sync.flush();
    expect(onReadonlyHold).not.toHaveBeenCalled();
    regrant(s, 2);
    expect(s.posted.length).toBe(1);
  });

  it("a THROWING hold notifier neither escapes flush nor costs the buffer", () => {
    const onReadonlyHold = vi.fn((): boolean => {
      throw new Error("notice failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({ onReadonlyHold });
      holdAb(s);
      readonlyAck(s, 2, "a");
      expect(() => s.sync.flush()).not.toThrow();
      expect(onReadonlyHold).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("onReadonlyHold threw"),
        expect.any(Error)
      );
      // A throw is not a decline: the notice may have been drawn part-way, so
      // later flushes do not call (and do not log) again.
      s.sync.flush();
      s.sync.flush();
      expect(onReadonlyHold).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      regrant(s, 2);
      expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stays silent before the first snapshot", () => {
    // NEGATIVE PIN: "readonly" means nothing until the host has said so once.
    vi.useFakeTimers();
    try {
      const onReadonlyHold = vi.fn();
      const t = timerSetup({ onReadonlyHold });
      t.change("typed pre-seed");
      t.sync.cancelPendingFlush(); // pre-seed capture
      // Diverge the live doc from the capture so the already-carried skip
      // cannot be what keeps this silent — only the pre-seed guard can.
      t.setDoc("");
      t.sync.flush();
      expect(onReadonlyHold).not.toHaveBeenCalled();
      expect(t.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent while the host already carries the held bytes, without spending the latch", () => {
    vi.useFakeTimers();
    try {
      const onReadonlyHold = vi.fn();
      const t = timerSetup({ onReadonlyHold });
      t.sync.onHostSnapshot(1, true, 0, 1);
      t.change("a");
      vi.advanceTimersByTime(300); // posts "a" — in flight
      t.change("ab");
      t.sync.flush(); // force-posts "ab" AND retains it (an Edit was in flight)
      expect(t.posted.length).toBe(2);
      // The host applied "ab" and went readonly: the live doc IS the held bytes.
      t.sync.onHostSnapshot(2, false, 0, 1);
      t.sync.onReducerCommit(false);
      t.sync.flush();
      expect(onReadonlyHold).not.toHaveBeenCalled(); // nothing is at risk
      // The view is then rewound past the held bytes: now they ARE at risk, and
      // the silent pass above must not have consumed the one announcement.
      t.setDoc("a");
      t.sync.flush();
      expect(onReadonlyHold).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a RE-ENTRANT hold notifier fires exactly once and posts nothing", () => {
    let target: ReturnType<typeof setup> | null = null;
    let calls = 0;
    const s = setup({
      onReadonlyHold: () => {
        calls++;
        target?.sync.flush(); // re-enter the announcing site mid-notice
        target?.sync.onReducerCommit(false); // and the drain
        return true;
      },
    });
    target = s;
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.flush();
    expect(calls).toBe(1);
    expect(s.posted.length).toBe(1);
    regrant(s, 2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });

  it("a RE-ENTRANT notifier that DECLINES fires once per flush and posts nothing", () => {
    // The latch is released only AFTER the notifier returns, so the nested
    // flush still finds it set; the decline then re-opens it for the next one.
    let target: ReturnType<typeof setup> | null = null;
    let calls = 0;
    const s = setup({
      onReadonlyHold: () => {
        calls++;
        target?.sync.flush();
        target?.sync.onReducerCommit(false);
        return false;
      },
    });
    target = s;
    holdAb(s);
    readonlyAck(s, 2, "a");
    s.sync.flush();
    expect(calls).toBe(1);
    expect(s.posted.length).toBe(1);
    s.sync.flush(); // the retry — again exactly one call
    expect(calls).toBe(2);
    expect(s.posted.length).toBe(1);
    regrant(s, 2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });
});

// The module's OTHER content-discarding path: replayIfNeeded drops a held buffer
// whose stamped lineage the host has moved past. Like the readonly hard drops it
// destroys bytes the user typed, so its trace must say HOW MUCH was lost — not
// only which lineage lost it — while never putting the bytes themselves in the
// console.
describe("cm edit-sync — stale-buffer drops are traced", () => {
  const SECRET = "SECRET-BYTES"; // 12 chars
  type WarnSpy = MockInstance<typeof console.warn>;
  const warnArgs = (spy: WarnSpy) =>
    spy.mock.calls.filter((c) => String(c[0]).includes("stale replay buffer"));

  it("reports the dropped and live lengths (not the bytes) when a foreign epoch lands", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 11); // seed on generation 11, epoch 0
      s.type(SECRET); // posts at v1, editInFlight = true
      s.type(`${SECRET}x`); // single-flight: buffered (len 13), stamped at epoch 0
      expect(s.posted.length).toBe(1);
      // Stand in for the reseed the foreign Document triggers (editor.ts owns
      // that): the live doc becomes the host's bytes while the buffer still
      // holds the user's ahead-of-host ones — the state where the two lengths
      // genuinely disagree, so neither number can stand for the other.
      s.setDoc("hi"); // len 2
      s.sync.onHostSnapshot(2, true, 1, 11); // same generation, epoch advanced
      s.sync.onReducerCommit(false); // drain → the stale buffer is dropped
      expect(s.posted.length).toBe(1); // nothing replayed over the foreign bytes
      expect(warnArgs(warn)).toEqual([
        [
          expect.stringContaining("stale replay buffer"),
          {
            stampGeneration: 11,
            stampEpoch: 0,
            recordedGeneration: 11,
            recordedEpoch: 1,
            droppedLength: SECRET.length + 1,
            liveLength: 2,
          },
        ],
      ]);
      expect(JSON.stringify(warnArgs(warn))).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });
});

// The THIRD content-discarding path, and the one this PR's notice exists for: the
// drain judges a loss on the settled IN-FLIGHT Edit when no buffer is held. It
// destroys typed bytes exactly as the two paths above do, so it owes the same
// record — otherwise a support report of the user notice is triageable for one
// holder and not for the other. ONE warn per drain: whichever holder lost.
describe("cm edit-sync — in-flight discards are traced", () => {
  const SECRET = "SECRET-BYTES"; // 12 chars
  type WarnSpy = MockInstance<typeof console.warn>;
  const inFlightWarns = (spy: WarnSpy) =>
    spy.mock.calls.filter((c) => String(c[0]).includes("un-acked in-flight Edit"));
  const bufferWarns = (spy: WarnSpy) =>
    spy.mock.calls.filter((c) => String(c[0]).includes("stale replay buffer"));
  const ackPair = (s: ReturnType<typeof setup>, v: number, epoch: number, generation: number) => {
    s.sync.onHostSnapshot(v, true, epoch, generation);
    s.sync.onReducerCommit(false);
  };

  it("reports both lineage pairs and both lengths (not the bytes) when the in-flight Edit is lost", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 11); // seed on generation 11, epoch 0
      s.type(SECRET); // posts at v1 — in flight, NOTHING buffered
      expect(s.posted.length).toBe(1);
      // Stand in for the reseed the foreign Document triggers (editor.ts owns
      // it): the live doc becomes the host's bytes while the settled in-flight
      // Edit still holds the user's, so the two lengths genuinely disagree.
      s.setDoc("hi"); // len 2
      ackPair(s, 2, 1, 11); // same generation, epoch advanced → foreign bytes won
      expect(inFlightWarns(warn)).toEqual([
        [
          expect.stringContaining("un-acked in-flight Edit"),
          {
            stampGeneration: 11,
            stampEpoch: 0,
            recordedGeneration: 11,
            recordedEpoch: 1,
            droppedLength: SECRET.length,
            liveLength: 2,
          },
        ],
      ]);
      expect(JSON.stringify(inFlightWarns(warn))).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT double-record: a lost BUFFER traces once, on the buffer branch only", () => {
    // Both branches run in one drain when a held buffer is the lost subject, so
    // the notice arm must stay quiet about a holder the drop already recorded.
    // Two warns for one discard would read in a support report as two losses.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup();
      s.sync.onHostSnapshot(1, true, 0, 11);
      s.type(SECRET); // posts — in flight
      s.type(`${SECRET}x`); // buffered: the NEWEST held bytes, stamped at epoch 0
      s.setDoc("hi"); // the reseed
      ackPair(s, 2, 1, 11); // buffer dropped AND lost (the doc carries neither)
      expect(bufferWarns(warn)).toHaveLength(1);
      expect(inFlightWarns(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
