// Webview→host edit single-flight + buffer/replay, framework-free.
//
// The host holds a write lock (QuollEditorPanel — `case "edit":` arm):
// while an Edit is applying, inbound Edits are dropped. So the webview
// posts at most ONE Edit at a time (editInFlight) and buffers the latest
// doc string for replay on the next non-stale Document ack. Text-canonical
// has no serialize step and no frontmatter side-channel — the buffer is a
// plain Markdown string.
//
// Driven by the shell's synchronous post-commit dispatch (editor.ts +
// shell.ts):
//   - onLocalChange from the CM updateListener (debounced post).
//   - onHostSnapshot from applyDocument (RECORD-ONLY metadata — never
//     touches editInFlight).
//   - onReducerCommit from the shell's dispatch wrapper after every
//     state-changing transition. It is the SOLE drain driver — the
//     reducer's committed editInFlight is passed in (single source of
//     truth), so it fires on same-docVersion acks, on a snapshot that
//     only moves docVersion, and on a serialize-error gate clear; it reads
//     the FRESH gate because it is post-commit; and it never double-posts a
//     genuine in-flight Edit. Folding all triggers into one entry point
//     makes a missed trigger impossible.
//   - cancelPendingFlush from the reseed path (captures the in-window
//     keystroke before the host snapshot lands).
// The reducer's serialize-error gate is injected as `canPost` so this
// module does NOT bypass it. (C8 retired the parse/serialize warning-
// consent gate — the serialize-error arm is the only one left.)

const DEBOUNCE_MS = 300;

export type EditSyncOptions = {
  /** Current editor doc as a raw Markdown string. */
  getDoc: () => string;
  /** Post an Edit to the host. Returns false if postMessage threw —
   *  the buffer is retained so the next ack can retry. */
  post: (content: string, baseDocVersion: number) => boolean;
  /** Save-policy gate (serialize-error clear? — `canPostEdit` in state.ts,
   *  wired through editor.ts). Blocks posting without losing the buffer.
   *  Defaults to always-allowed. */
  canPost?: () => boolean;
  /** Test seam: run the flush synchronously instead of via setTimeout. */
  scheduleFlush?: (run: () => void) => void;
};

export type EditSync = {
  /** Editor content changed locally (CM updateListener docChanged). */
  onLocalChange: () => void;
  /** A host Document arrived — RECORD-ONLY metadata. Sets the version +
   *  canWrite edit-sync echoes on the next Edit. Does NOT touch
   *  editInFlight and does NOT drain (that is onReducerCommit's job).
   *  Stale (older docVersion) Documents are ignored. `canWrite` is the
   *  FRESH value threaded from message.canWrite. Called synchronously
   *  from applyDocument.
   *
   *  RESPONSIBILITY SPLIT: a single Document carries TWO host signals
   *  that an earlier `onDocument` conflated — "here is the current
   *  snapshot" (metadata + reseed) and "I acked your in-flight Edit"
   *  (clear editInFlight + drain). Conflating them created a two-state
   *  divergence (historically a parse-failure Document cleared edit-sync's
   *  editInFlight while the reducer left state.editInFlight untouched —
   *  the parse-failure path is retired as of C8) and missed
   *  same-docVersion acks. The
   *  split: onHostSnapshot records metadata only; the reducer's
   *  `state.editInFlight` is the SINGLE source of truth, passed into
   *  onReducerCommit, which is the only thing that clears edit-sync's
   *  flag + drains. So edit-sync never derives in-flight from a Document
   *  arrival. */
  onHostSnapshot: (docVersion: number, canWrite: boolean) => void;
  /** The reducer committed — re-evaluate and drain. This is the SINGLE
   *  post-commit drain entry point. The shell fires it from its dispatch
   *  wrapper after every state-changing transition, governed by an
   *  invariant: every reducer field `replayIfNeeded`'s guard reads — the
   *  ack (`state.editInFlight`), the write capability (`state.canWrite`),
   *  the serialize-error gate (`state.serializeError`) — PLUS the
   *  host-snapshot trigger `state.docVersion`. `editInFlight` is the reducer's
   *  COMMITTED value, passed in so edit-sync's flag tracks the single
   *  source of truth rather than being independently derived from
   *  Document arrivals (which caused both the lock-step divergence and
   *  the same-docVersion miss).
   *
   *  Why one method + one entry point: an earlier draft split the drain
   *  into `onAck` (keyed on editInFlight) and `onGateChanged` (keyed on
   *  the gate). That left triggers uncovered — a host snapshot that
   *  advances `docVersion` without changing editInFlight or the gate (a
   *  Document interrupting a debounce window captured a keystroke via
   *  cancelPendingFlush that then NOTHING drained → silent loss), and a
   *  same-docVersion Document that re-grants `canWrite` false→true (a
   *  held buffer stranded because no effect keyed on canWrite). Folding
   *  all triggers into one entry point governed by the dependency
   *  invariant makes a missed trigger structurally impossible. Because
   *  the call is still post-commit, `canPost()` reads the FRESH gate;
   *  because `editInFlight` is passed from the reducer, same-docVersion
   *  acks fire it (editInFlight transitions even when the version does
   *  not) and a genuine in-flight Edit is never double-posted (`drain`
   *  returns early when the passed `editInFlight` is true). No-op when
   *  nothing is buffered, the gate is closed, the doc is unseeded, or an
   *  Edit is genuinely in flight. */
  onReducerCommit: (editInFlight: boolean) => void;
  /** Cancel any scheduled debounced flush — called by the reseed path
   *  BEFORE the host snapshot is written so a pending flush cannot post
   *  the snapshot back as an echo Edit. (A `seeding` flag alone would
   *  only suppress the listener, not an already-scheduled flush.)
   *  Captures the latest doc into the buffer BEFORE clearing the timer,
   *  so an in-debounce-window keystroke is not lost. */
  cancelPendingFlush: () => void;
  /** Drop any held pre-ack buffer. Distinct from `cancelPendingFlush`
   *  (which captures the latest doc into the buffer before clearing the
   *  timer) — `discardBuffer` does the opposite: it throws away the
   *  buffered content because the editor's caller knows the buffer is
   *  stale (e.g. host-rejected pre-reject bytes that, if replayed,
   *  would just re-reject and flicker the banner). DOES NOT touch
   *  `editInFlight` — the host still has whatever was in-flight; the
   *  next ack is still its rightful clear point. */
  discardBuffer: () => void;
  /** TEARDOWN-precursor signals (`visibilitychange:hidden` / `pagehide` /
   *  `blur` — see shell.ts). Force-posts the latest pending content to the host
   *  EVEN while an Edit is in flight (unlike `trySend`, which buffers-and-waits
   *  under single-flight): on a real tab close the iframe is destroyed before
   *  the next ack, so the host — which stashes the in-flight arrival and drains
   *  it on settlement (QuollEditorPanel `applyEditSettled`) — is a place the
   *  bytes can survive. On a successful post it sets editInFlight (keeping
   *  single-flight intact on an ALIVE hide→show / blur→focus so the next
   *  keystroke buffers rather than double-posting).
   *
   *  BUFFER RETENTION IS CONDITIONAL on there having been an Edit in flight —
   *  it mirrors `trySend`, which retains only under single-flight and nulls on
   *  an idle post:
   *    - Edit in flight → RETAIN. The host stash covers ONLY the lock-held
   *      window; if the host has ALREADY settled that in-flight Edit (lock
   *      released, ack in transit), this force-post carries a now-stale
   *      docVersion, misses the stash, and is `stale`-rejected → the
   *      authoritative Document reposts over the typed bytes. Retaining lets the
   *      next ack replay them at the fresh docVersion (double delivery is
   *      idempotent via the host `no-op` verdict; `replayIfNeeded` nulls the
   *      buffer on its own post, so it is exactly ONE replay). On a real close
   *      the retained buffer is simply never replayed (iframe gone).
   *    - Nothing in flight → NULL (like trySend's idle post). The force-post
   *      lands at a matching version and is `accept`ed outright, so the host is
   *      already the authority for those bytes; retaining them would serve no
   *      recovery purpose and could later replay already-applied content over a
   *      racing EXTERNAL edit — the host has no client-side conflict guard for a
   *      post-settlement replay, so that would silently clobber the external
   *      change.
   *
   *  Still a HARD DROP under readonly, a buffer-keeping hold pre-seed / while
   *  the serialize-error gate is closed, and a buffer-keeping hold when the post
   *  itself fails. NOT a mid-session call — for a reseed always use
   *  `cancelPendingFlush` (capture-preserving), never `flush`. */
  flush: () => void;
  /** Mid-session flush barrier (context-handoff): clear the debounce timer and,
   *  if a keystroke was typed inside the window, post it NOW — but RESPECT
   *  single-flight (buffer for replay when an Edit is already in flight) rather
   *  than force-posting like `flush`. Use this for barriers where the panel
   *  STAYS ALIVE afterward (a handoff): `flushIfIdle` never posts a second Edit
   *  at a stale version — trySend buffers the in-flight case, so the normal
   *  ack→replay path preserves the keystrokes with no redundant round-trip.
   *  `flush` force-posts even while in flight (it must, for teardown) and can
   *  therefore emit a `stale`-rejected Edit in the ack-in-transit window; in
   *  that in-flight case it RETAINS the buffer so the reseed cannot strand the
   *  bytes, but that costs an extra idempotent round-trip `flushIfIdle` avoids.
   *  Reserve `flush`
   *  for TEARDOWN paths (visibilitychange / pagehide / switch-to-text) where the
   *  panel may dispose and the host stash / retained buffer are the last
   *  authorities. No-op when nothing was typed in the debounce window. */
  flushIfIdle: () => void;
  /** True when `content` is byte-identical to the Edit currently awaiting its
   *  ack (single-flight → at most one). The reseed path (editor.ts
   *  applyDocument) uses this to recognise a host Document that merely ECHOES
   *  our own in-flight edit back — an ok-ack. When the live buffer has since
   *  advanced past those bytes (the user kept typing during the in-flight
   *  window), reseeding the doc back to the acked content would visibly rewind
   *  the newer keystrokes; folding the ack into version bookkeeping instead lets
   *  the buffered edit replay them forward. Because the live buffer is always a
   *  descendant of what we posted, an echo match means the acked content is a
   *  strict ancestor of the buffer, so skipping the visible reseed is safe.
   *  False whenever nothing is in flight (so genuine external divergence — which
   *  never matches our posted bytes — still reseeds). */
  echoesInFlightEdit: (content: string) => boolean;
};

export function createEditSync(opts: EditSyncOptions): EditSync {
  const canPost = opts.canPost ?? (() => true);
  let docVersion = 0;
  let seeded = false;
  let canWrite = false;
  let editInFlight = false;
  // The content of the Edit currently awaiting its ack — non-null EXACTLY while
  // `editInFlight` is true (paired with every editInFlight assignment below).
  // Read by `echoesInFlightEdit` so the reseed path can recognise an ok-ack.
  let inFlightContent: string | null = null;
  let buffered: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (run: () => void): void => {
    if (opts.scheduleFlush) {
      opts.scheduleFlush(run);
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, DEBOUNCE_MS);
  };

  const trySend = (): void => {
    // Readonly is a HARD DROP, not a buffered hold. The Compartment
    // makes a `canWrite=false` doc genuinely non-editable, so a
    // docChanged under readonly can only come from a programmatic
    // command this layer is the last defense against; retaining it
    // would let a later write-granting ack (onReducerCommit) replay
    // content that was never legitimately editable. cancelPendingFlush
    // below mirrors this contract (the `seeded && !canWrite` branch
    // nulls the buffer for the same reason).
    if (!canWrite) {
      buffered = null;
      return;
    }
    if (!seeded || !canPost()) {
      // Gate held / pre-seed (NOT readonly): keep the content buffered
      // so a later ack or serialize-error gate clear can replay it; do not
      // drop it.
      buffered = opts.getDoc();
      return;
    }
    const content = opts.getDoc();
    if (editInFlight) {
      buffered = content; // single-flight: stash latest, replay on ack
      return;
    }
    editInFlight = true;
    const ok = opts.post(content, docVersion);
    if (ok) {
      buffered = null;
      inFlightContent = content;
    } else {
      // postMessage threw: drop the in-flight flag so a later ack/change
      // can retry, and retain the buffered content.
      editInFlight = false;
      inFlightContent = null;
      buffered = content;
    }
  };

  const replayIfNeeded = (): void => {
    // Replay whenever a buffer survives and the gate is open — NO
    // `buffered === getDoc()` echo-skip. After a host reseed the CM doc
    // IS the host snapshot, so `buffered === getDoc()` would be TRUE
    // for exactly the keystrokes we must replay (the user typed them
    // before the ack reseeded the doc) and would silently drop them.
    // Echo is already prevented upstream by the `seeding` guard +
    // `cancelPendingFlush` in editor.ts — the buffer here only ever
    // holds genuine pre-ack user input, never the host's own bytes.
    //
    // The `editInFlight` guard is load-bearing. Without it, a gate
    // clear (serialize-error retry) firing while an Edit is already in
    // flight would post a
    // SECOND Edit at the same docVersion. The host write lock
    // (QuollEditorPanel — `case "edit":` arm) drops the second, but
    // `post` still returns true (postMessage did not throw), so we
    // would null `buffered` — losing the keystrokes the host never
    // applied. With the guard, an in-flight buffer waits for the real
    // ack (onReducerCommit clears editInFlight when the reducer's
    // committed value is false, THEN drains).
    //
    // The `!seeded` guard mirrors trySend's pre-seed hold. A buffer
    // captured before the first host snapshot (e.g. cancelPendingFlush
    // on a pre-seed reseed) must NOT post with the placeholder
    // docVersion 0; it waits for the seed. Symmetric with trySend's
    // `!seeded || !canPost()` arm.
    if (buffered === null || !seeded || editInFlight || !canWrite || !canPost()) {
      return;
    }
    const content = buffered;
    editInFlight = true;
    const ok = opts.post(content, docVersion);
    if (ok) {
      buffered = null;
      inFlightContent = content;
    } else {
      editInFlight = false;
      inFlightContent = null;
      buffered = content;
    }
  };

  return {
    onLocalChange: () => schedule(trySend),
    // RECORD-ONLY host snapshot metadata. Updates the version + canWrite
    // edit-sync echoes on its next Edit. It does NOT clear editInFlight
    // and does NOT drain — those belong to onReducerCommit, driven by
    // the reducer's committed `state.editInFlight`. (Earlier drafts
    // cleared editInFlight here and/or replayed; both created the
    // divergences the doc comment on onHostSnapshot above details.)
    onHostSnapshot: (nextVersion, nextCanWrite) => {
      if (seeded && nextVersion < docVersion) {
        return; // stale — shell-level guard also drops it
      }
      docVersion = nextVersion;
      canWrite = nextCanWrite;
      seeded = true;
    },
    // The SINGLE post-commit drain. `committedEditInFlight` is the
    // reducer's committed `state.editInFlight` — the single source of
    // truth. If the reducer says an Edit is still in flight, do nothing
    // (wait for its real ack). Otherwise sync our flag to the reducer's
    // truth and drain. One method fed by one entry point whose deps
    // carry ALL triggers (ack / snapshot / serialize-error gate clear),
    // so a missed trigger is structurally impossible. Still post-commit, so
    // canPost() reads the fresh gate; fires on same-docVersion acks
    // because editInFlight transitions even when the version does not;
    // and when the reducer reports a genuine in-flight Edit
    // (committedEditInFlight true) we keep our flag true and skip the drain
    // (the early return below), so edit-sync and the reducer never diverge.
    onReducerCommit: (committedEditInFlight) => {
      if (committedEditInFlight) {
        return; // genuine in-flight Edit — wait for its ack
      }
      editInFlight = false; // sync to the reducer's committed truth
      inFlightContent = null;
      replayIfNeeded();
    },
    // Capture the latest doc into the buffer BEFORE clearing the timer.
    // onLocalChange always DEBOUNCES, so a keystroke typed inside the
    // 300 ms window has NOT yet reached `buffered`; if a host Document
    // arrives and applyDocument calls cancelPendingFlush() then reseeds,
    // that keystroke would be lost under the host snapshot. Snapshotting
    // getDoc() here (subject to the same readonly/gate rules as trySend)
    // preserves it for replay on the next onReducerCommit (the
    // docVersion change drains it). We do NOT post here (that is the
    // reseed path — posting would echo); we only stash.
    cancelPendingFlush: () => {
      // The timer-null branch is intentional: if no flush is scheduled,
      // either nothing was typed in the debounce window (no capture
      // needed) OR the timer already fired and trySend ran (the
      // keystroke was already sent to the host, with editInFlight=true
      // and buffered=null, via trySend's own path — not re-captured
      // here). Capturing unconditionally would re-buffer an
      // already-posted Edit. Only the "typed inside the window, not yet
      // flushed" case needs the capture — that's the timer !== null
      // case.
      if (timer !== null) {
        if (seeded && !canWrite) {
          buffered = null; // readonly hard drop
        } else {
          buffered = opts.getDoc();
        }
      }
      clearTimer();
    },
    discardBuffer: () => {
      buffered = null;
    },
    flush: () => {
      // TEARDOWN-precursor signal (visibilitychange:hidden / pagehide / blur).
      // Force the latest pending bytes to the host even while an Edit is in
      // flight (bypassing trySend's single-flight buffer arm). Post-success
      // buffer handling is CONDITIONAL on prior in-flight state — see the flush
      // JSDoc for the full rationale (settlement→ack stale recovery vs the
      // external-edit clobber the accept path would cause). Same gates as
      // trySend: readonly is a HARD DROP; pre-seed / serialize-error gate keeps
      // the buffer; a failed post keeps the buffer for the next ack.
      const hadTimer = timer !== null;
      clearTimer();
      const content = hadTimer ? opts.getDoc() : buffered;
      if (content === null) {
        return; // nothing pending — genuine no-op
      }
      if (!canWrite) {
        buffered = null; // readonly hard drop (mirrors trySend)
        return;
      }
      if (!seeded || !canPost()) {
        buffered = content; // pre-seed / gate closed: keep for a later drain
        return;
      }
      const wasInFlight = editInFlight;
      const ok = opts.post(content, docVersion);
      if (ok) {
        editInFlight = true; // maintain single-flight even on an alive hide→show
        inFlightContent = content;
        // Retain for ack-replay ONLY under in-flight contention (the sole path
        // to the stale settlement→ack window); otherwise the host accepted the
        // post and is the authority, so null it like trySend's idle post (JSDoc).
        buffered = wasInFlight ? content : null;
      } else {
        buffered = content; // post failed: keep for the next ack
      }
    },
    flushIfIdle: () => {
      // Only act when a keystroke is pending in the debounce window; otherwise
      // the latest bytes are already posted / in-flight / buffered-for-replay,
      // so there is nothing to force (matches flush's no-op-when-nothing-typed).
      // trySend RESPECTS single-flight: posts when idle, buffers when an Edit is
      // in flight — never the force-post-even-while-in-flight that flush does
      // (flush can emit a stale-rejected Edit + one idempotent replay round-trip;
      // flushIfIdle emits neither).
      const hadTimer = timer !== null;
      clearTimer();
      if (hadTimer) {
        trySend();
      }
    },
    echoesInFlightEdit: (content) => inFlightContent !== null && content === inFlightContent,
  };
}
