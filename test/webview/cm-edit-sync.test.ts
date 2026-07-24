import { describe, expect, it, vi } from "vitest";
import { createEditSync } from "../../src/webview/cm/edit-sync.js";

type Posted = { content: string; baseDocVersion: number };

function setup(opts?: {
  blockPost?: () => boolean;
  failPost?: boolean;
  now?: () => number;
  onResyncStorm?: () => void;
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
    s.sync.onHostSnapshot(v, canWrite);
    s.sync.onReducerCommit(false); // reducer's document arm cleared editInFlight
  };
  // A consent flip / serialize-error clear: reducer state changed, NOT
  // in-flight, no docVersion move. Production fires onReducerCommit(false).
  const consentFlip = (s: ReturnType<typeof setup>) => s.sync.onReducerCommit(false);

  it("posts the current doc with the base docVersion on a local change", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    s.type("hello world");
    expect(s.posted).toEqual([{ content: "hello world", baseDocVersion: 1 }]);
  });

  it("buffers a second change while in flight, replays on the next ack", () => {
    // Review fix #25: the ack-drain is onReducerCommit(false), fired by the
    // post-commit effect. The test mirrors that snapshot→commit sequence.
    const s = setup();
    s.sync.onHostSnapshot(1, true);
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
    s.sync.onHostSnapshot(1, true);
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
    s.sync.onHostSnapshot(2, true);
    s.type("a"); // posts at v2, editInFlight = true
    s.type("ab"); // buffered while in flight (legitimately, canWrite=true)
    expect(s.posted.length).toBe(1);
    // Transient readonly at the SAME docVersion: ack clears in-flight, but
    // the buffer is HELD (not dropped) because canWrite is now false.
    s.sync.onHostSnapshot(2, false);
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(1); // still held — not posted, not dropped
    // Write re-granted at the SAME docVersion. The canWrite flip in the
    // next dispatch triggers onReducerCommit; the held buffer drains.
    s.sync.onHostSnapshot(2, true);
    s.sync.onReducerCommit(false);
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
  });

  it("does NOT post a second Edit while one is in flight (Issue3 + #25)", () => {
    // A reducer commit that reports editInFlight=true (e.g. a consent flip
    // mutated state while an Edit is genuinely in flight) must NOT post a
    // concurrent second Edit. onReducerCommit(true) returns early.
    const s = setup();
    s.sync.onHostSnapshot(1, true);
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
    s.sync.onHostSnapshot(1, false);
    s.type("x"); // readonly → dropped, buffer NOT retained
    expect(s.posted).toEqual([]);
    ack(s, 2, true); // host grants write — must NOT replay "x"
    expect(s.posted).toEqual([]);
  });

  it("does not post while the warning/consent gate blocks", () => {
    let blocked = true;
    const s = setup({ blockPost: () => blocked });
    s.sync.onHostSnapshot(1, true);
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
    s.sync.onHostSnapshot(1, true);
    s.type("typed while blocked");
    expect(s.posted).toEqual([]); // held by the gate
    blocked = false;
    consentFlip(s); // gate opens — drain WITHOUT a synthetic local change
    expect(s.posted).toEqual([{ content: "typed while blocked", baseDocVersion: 1 }]);
  });

  it("retains the buffer when post fails (postMessage threw)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
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
    // snapshot — nothing posts until the seed arrives.
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
    sync.onHostSnapshot(1, true); // first seed
    sync.onReducerCommit(false); // now it may drain
    expect(posted).toEqual([{ content: "pre-seed text", baseDocVersion: 1 }]);
  });

  it("ignores a stale host snapshot (older docVersion)", () => {
    // No replay assertion here — the post comes from trySend (onLocalChange).
    // Pins that the stale onHostSnapshot does not clobber the live docVersion
    // the next Edit echoes as its base.
    const s = setup();
    s.sync.onHostSnapshot(5, true);
    s.sync.onHostSnapshot(3, true); // stale — ignored, docVersion stays 5
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
    sync.onHostSnapshot(1, true);
    doc = "typed";
    sync.onLocalChange(); // schedules a real-timer flush (not yet buffered)
    // Reseed path, in production order: capture-then-cancel happens while
    // doc is still "typed"; the host reseed to "host-snapshot" follows.
    sync.cancelPendingFlush(); // buffers "typed" + clears timer
    doc = "host-snapshot"; // the CM reseed lands AFTER the capture
    expect(posted).toEqual([]); // nothing posted yet (no echo of host bytes)
    // The reducer commit drains the captured keystroke — "typed" survived the
    // reseed, and "host-snapshot" was never echoed.
    sync.onHostSnapshot(2, true);
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
    sync.onHostSnapshot(1, true);
    doc = "seed!"; // user typed one char inside the window
    sync.onLocalChange(); // debounced, NOT yet buffered, editInFlight false
    sync.cancelPendingFlush(); // Document interrupts mid-window → captures "seed!"
    doc = "host snapshot"; // host reseed lands after capture
    sync.onHostSnapshot(2, true); // docVersion 1→2, editInFlight still false
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(2, true);
      // Second Document arrives before any commit:
      sync.onHostSnapshot(3, true);
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

describe("cm edit-sync — echoesInFlightEdit", () => {
  const ack = (s: ReturnType<typeof setup>, v: number, canWrite = true) => {
    s.sync.onHostSnapshot(v, canWrite);
    s.sync.onReducerCommit(false);
  };

  it("is false before anything is posted", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    expect(s.sync.echoesInFlightEdit("hello")).toBe(false);
  });

  it("is true for the exact bytes of the Edit currently in flight", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    s.type("hello world"); // posts, editInFlight = true
    expect(s.sync.echoesInFlightEdit("hello world")).toBe(true);
    // A different string (a genuine external divergence) never matches.
    expect(s.sync.echoesInFlightEdit("something else")).toBe(false);
  });

  it("clears when the reducer commit acks the in-flight Edit", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    s.type("a"); // posts, editInFlight = true
    expect(s.sync.echoesInFlightEdit("a")).toBe(true);
    ack(s, 2); // ack clears editInFlight
    expect(s.sync.echoesInFlightEdit("a")).toBe(false);
  });

  it("tracks the newest in-flight bytes across a buffered replay", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    s.type("a"); // posts "a", editInFlight = true
    s.type("ab"); // buffered while in flight
    expect(s.sync.echoesInFlightEdit("a")).toBe(true); // still "a" in flight
    ack(s, 2); // ack "a" → replay drains "ab" → "ab" now in flight
    expect(s.sync.echoesInFlightEdit("ab")).toBe(true);
    expect(s.sync.echoesInFlightEdit("a")).toBe(false);
  });

  it("clears when a post fails (no phantom in-flight echo)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true);
    s.setPostOk(false);
    s.type("x"); // post returns false → not in flight
    expect(s.sync.echoesInFlightEdit("x")).toBe(false);
  });
});

describe("cm edit-sync — discardBuffer", () => {
  const ack = (s: ReturnType<typeof setup>, v: number, canWrite = true) => {
    s.sync.onHostSnapshot(v, canWrite);
    s.sync.onReducerCommit(false);
  };

  it("clears a buffered pre-reject payload so the next drain does not replay it", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true); // seeded + writable
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
    s.sync.onHostSnapshot(1, true);
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
    s.sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(2, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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

  it("echoesInFlightEdit recognises the force-posted content after an idle flush (alive hide→show)", () => {
    // flush()'s success branch sets inFlightContent so a subsequent ok-ack that
    // echoes the force-posted bytes is recognised as an echo (and folded by
    // applyDocument) rather than reseeding backwards — the same protection
    // trySend/replayIfNeeded give, but reached through the teardown/hide path.
    // Revert-check: delete `inFlightContent = content;` from flush's ok branch →
    // this test goes red (echoesInFlightEdit returns false).
    vi.useFakeTimers();
    try {
      let doc = "seed";
      const sync = createEditSync({
        getDoc: () => doc,
        post: () => true,
      });
      sync.onHostSnapshot(1, true);
      doc = "seed+edit";
      sync.onLocalChange(); // timer pending, idle (no prior in-flight)
      sync.flush(); // force-posts "seed+edit"; must record it as in-flight
      expect(sync.echoesInFlightEdit("seed+edit")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush under readonly hard-drops the buffer (no post)", () => {
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
      sync.onHostSnapshot(1, false); // readonly
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(1, true);
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
      sync.onHostSnapshot(2, true);
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
      sync.onHostSnapshot(1, true);
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

  it("records null for an omitted pair (old-host tolerance)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true); // legacy host: no pair
    expect(s.sync.recordedIdentity()).toEqual({ epoch: null, generation: null });
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
    epoch: number | undefined,
    generation: number | undefined,
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

  it("(d2) drops a buffer stamped under an ABSENT pair when the pair appears (absent→present)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true); // legacy host — no pair
    s.type("a"); // posts, in flight
    s.type("ab"); // buffered {epoch:null, gen:null}
    expect(s.posted.length).toBe(1);
    ackPair(s, 2, 0, 42); // pair appears → identity transition → drop
    expect(s.posted.length).toBe(1);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 42 });
  });

  it("(d3) drops a buffer when a legacy Document downgrades the pair (present→absent)", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true, 0, 42);
    s.type("a"); // posts, in flight
    s.type("ab"); // buffered {epoch:0, gen:42}
    expect(s.posted.length).toBe(1);
    ackPair(s, 2, undefined, undefined); // host downgraded → present→absent → drop
    expect(s.posted.length).toBe(1);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: null, generation: null });
  });

  it("keeps a pure-absent (legacy throughout) buffer replayable — today's behaviour", () => {
    const s = setup();
    s.sync.onHostSnapshot(1, true); // legacy
    s.type("a"); // posts, in flight
    s.type("ab"); // buffered {null, null}
    expect(s.posted.length).toBe(1);
    ackPair(s, 2, undefined, undefined); // still legacy → no drop → replay
    expect(s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ content: "ab", baseDocVersion: 2 });
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

  it("(f) B→absent→B: a legacy straggler at a LOWER version is adopted, stream continues", () => {
    const s = setup();
    s.sync.onHostSnapshot(10, true, 0, 222); // B at v10
    // Legacy (pair-less) straggler at a LOWER version — present→absent transition.
    // A same-or-higher version would pass the stale guard anyway; the lower
    // version proves the bypass is exercised.
    s.sync.onHostSnapshot(5, true);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: null, generation: null });
    // Live host B re-adopts (absent→present).
    s.sync.onHostSnapshot(6, true, 1, 222);
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 1, generation: 222 });
    s.sync.onReducerCommit(false);
    s.type("y");
    expect(s.posted[s.posted.length - 1]).toEqual({ content: "y", baseDocVersion: 6 });
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

  it("isIdentityTransition is a pure predicate (no side effects, agrees across calls)", () => {
    const onResyncStorm = vi.fn();
    const s = setup({ onResyncStorm });
    s.sync.onHostSnapshot(1, true, 0, 111);
    // Repeated pure queries must not count toward the tripwire nor mutate state.
    for (let i = 0; i < 5; i++) {
      expect(s.sync.isIdentityTransition(0, 222)).toBe(true); // new generation
      expect(s.sync.isIdentityTransition(9, 111)).toBe(false); // same generation
      expect(s.sync.isIdentityTransition(undefined, undefined)).toBe(true); // present→absent
    }
    expect(onResyncStorm).not.toHaveBeenCalled();
    expect(s.sync.recordedIdentity()).toEqual({ epoch: 0, generation: 111 });
  });

  it("treats the first snapshot as an adoption, not a transition (no tripwire count)", () => {
    const s = setup();
    expect(s.sync.isIdentityTransition(0, 111)).toBe(false); // before any snapshot
  });
});
