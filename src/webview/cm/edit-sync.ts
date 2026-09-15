// Webview→host edit single-flight + buffer/replay, framework-free.
//
// The host holds a write lock (QuollEditorPanel — `case "edit":` arm):
// while an Edit is applying, inbound Edits are dropped. So the webview
// posts at most ONE Edit at a time (editInFlight) and buffers the latest
// doc string for replay on the next non-stale Document ack. Text-canonical
// has no serialize step and no frontmatter side-channel — the buffered
// content is a plain Markdown string (S3b wraps it in a BufferedEdit that
// also carries the capture-time (epoch, generation) identity stamp).
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

// Clustering escalation tripwire (S3b): ≥3 identity transitions within this
// rolling window fire ONE per-session low-alarm notice. Defence-in-depth for
// the acknowledged straggler-storm residual — surfaces a silently-repeating
// resync to the user (log-only is insufficient; the S4 abort-toast precedent).
const IDENTITY_FLAP_WINDOW_MS = 5 * 60 * 1000;
const IDENTITY_FLAP_THRESHOLD = 3;

/** A pre-ack replay buffer stamped with the (epoch, generation) identity pair
 *  recorded at capture time (S3b). `replayIfNeeded` compares the stamp against
 *  the currently recorded pair and DROPS the buffer on a foreign epoch advance
 *  or any identity transition — the webview then mirrors the host's external-
 *  wins policy instead of clobbering it one round-trip later. `epoch`/`generation`
 *  are `null` when captured under a legacy (pair-less) host. */
type BufferedEdit = DocumentIdentity & { content: string };

/** A Document's (externalEpoch, epochGeneration) pair in edit-sync's internal
 *  form. The wire pair is EXCLUSIVE (both present or both absent — validator-
 *  authoritative, see protocol.ts); absence is carried as `null` on BOTH fields
 *  so a single comparison rule can read stamps and incoming Documents alike.
 *  Both fields are `readonly`: a pair is REPLACED as a whole (its one write
 *  site builds a fresh pair through `incomingIdentity`), never amended one wing
 *  at a time, so "advance the epoch and leave the generation behind" cannot be
 *  written. Constructing a half-pair LITERAL still type-checks — closing that
 *  needs a sum type, which costs more test churn than the hole is worth. */
type DocumentIdentity = { readonly epoch: number | null; readonly generation: number | null };

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
  /** Clock for the identity-transition clustering tripwire (S3b). Injected so
   *  tests can simulate the 5-minute rolling window deterministically.
   *  Defaults to `Date.now`. */
  now?: () => number;
  /** Fired ONCE per session when identity transitions cluster (≥3 within the
   *  5-minute window) — the clustering escalation tripwire (S3b). The wiring
   *  surfaces a low-alarm user-visible notice ("Quoll re-synced with the editor
   *  host repeatedly — recent keystrokes may not have been saved"). Never fired
   *  per-transition; latched after the first alarm. Defaults to a no-op. */
  onResyncStorm?: () => void;
};

export type EditSync = {
  /** Editor content changed locally (CM updateListener docChanged). */
  onLocalChange: () => void;
  /** A host Document arrived — RECORD-ONLY metadata. Sets the version +
   *  canWrite edit-sync echoes on the next Edit. Does NOT touch
   *  editInFlight and does NOT drain (that is onReducerCommit's job).
   *  Stale (older docVersion) Documents are ignored ONLY within one host
   *  identity: on an identity transition (and before the first snapshot) the
   *  incoming version/pair is adopted unconditionally, because version ordering
   *  is meaningful only within one generation (S3b). `canWrite` is the
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
  onHostSnapshot: (
    docVersion: number,
    canWrite: boolean,
    externalEpoch?: number,
    epochGeneration?: number
  ) => void;
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
   *  so an in-debounce-window keystroke is not lost — UNLESS the doc is
   *  currently readonly, in which case the captured keystroke is a HARD
   *  DROP (see `warnReadonlyDrop`), mirroring `trySend`. */
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
  /** Is this incoming Document the ack of our own in-flight Edit? TWO conditions,
   *  deliberately answered by ONE call so a caller cannot check half of it:
   *
   *  1. `content` is byte-identical to the Edit currently awaiting its ack
   *     (single-flight → at most one). False whenever nothing is in flight, so a
   *     genuine external divergence — which never matches our posted bytes —
   *     still reseeds.
   *  2. The Document's identity pair CONTINUES the lineage we are carrying —
   *     same generation with the epoch not advanced, OR (legacy tolerance)
   *     neither side carries a pair at all, which keeps a pair-less host on the
   *     old unconditional-fold behaviour. Content equality alone does not make a
   *     Document ours: another writer can produce byte-identical bytes, and the
   *     host then reports a foreign epoch advance / a new generation. The
   *     lineage compared against is the held replay buffer's stamp when one is
   *     held (it is the content whose survival the fold predicts) and the
   *     recorded pair otherwise. Pass the incoming pair BEFORE `onHostSnapshot`
   *     records it (applyDocument's order), so the comparison is
   *     incoming-vs-previous. Both arguments are required — pass `undefined`
   *     explicitly for a legacy pair-less host.
   *
   *  The reseed path (editor.ts applyDocument) uses this to recognise a host
   *  Document that merely ECHOES our own in-flight edit back. When the live
   *  buffer has since advanced past those bytes (the user kept typing during the
   *  in-flight window), reseeding back to the acked content would visibly rewind
   *  the newer keystrokes; folding the ack into version bookkeeping instead lets
   *  the buffered edit replay them forward. Because the live buffer is always a
   *  descendant of what we posted, an echo match on our own lineage means the
   *  acked content is a strict ancestor of the buffer, so skipping the visible
   *  reseed is safe. Condition 2 is what keeps that reasoning true: it holds the
   *  fold to exactly the Documents whose replay buffer `replayIfNeeded` will
   *  still replay — on a superseded lineage the buffer is DROPPED, so folding
   *  would leave the ahead keystrokes visible but unsavable. */
  acksInFlightEdit: (
    content: string,
    externalEpoch: number | undefined,
    epochGeneration: number | undefined
  ) => boolean;
  /** The Document identity pair (externalEpoch, epochGeneration) recorded from
   *  the most recent accepted host snapshot — `null` before the first snapshot
   *  or when the host omitted the pair (old-host tolerance). TWO consumers read
   *  it through the shared `supersedesIdentity` rule: the replay side
   *  (`shouldDropBufferedForEpoch`, which drops a held buffer on a foreign epoch
   *  advance or an identity transition) and the display side
   *  (`acksInFlightEdit`, which gates the reseed path's ok-ack fold and falls
   *  back to this pair when no buffer is held). They must agree — see
   *  `supersedesIdentity`. */
  recordedIdentity: () => DocumentIdentity;
  /** Pure predicate (no side effects): would an incoming Document's identity
   *  pair be an identity transition against the CURRENTLY recorded pair? True
   *  on a different generation, absent→present, or present→absent; false for a
   *  same-generation Document, a pure-absent (legacy) pair, or before the first
   *  snapshot (the seed is an adoption, not a transition). The shell reads this
   *  BEFORE `applyDocument` to bypass its whole-Document stale-version drop on a
   *  transition; `onHostSnapshot` recomputes it internally to bypass its own
   *  stale guard, count the tripwire, and adopt the pair (both read the same
   *  unchanged recorded pair, so they agree). Version ordering is meaningful
   *  only WITHIN one host generation (S3b). */
  isIdentityTransition: (externalEpoch?: number, epochGeneration?: number) => boolean;
};

export function createEditSync(opts: EditSyncOptions): EditSync {
  const canPost = opts.canPost ?? (() => true);
  let docVersion = 0;
  let seeded = false;
  let canWrite = false;
  let editInFlight = false;
  // The content of the Edit currently awaiting its ack — non-null EXACTLY while
  // `editInFlight` is true (paired with every editInFlight assignment below).
  // Read by `acksInFlightEdit` so the reseed path can recognise an ok-ack.
  let inFlightContent: string | null = null;
  let buffered: BufferedEdit | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Document identity pair from the most recent accepted host snapshot (S3a
  // recorded it; S3b now acts on it). Both fields are `null` before the first
  // snapshot / when the host omits the pair. Read in replayIfNeeded's drop
  // check, at each buffer capture (via stampBuffer), by isIdentityTransition,
  // and — via recordedIdentity(), as the no-buffer-held fallback — by
  // acksInFlightEdit's lineage conjunct. So BOTH the replay side and the
  // display (ok-ack fold) side read it, not the replay side alone.
  // ONE variable holding the PAIR, not two independent wings: with two `let`s a
  // write could land on one and miss the other, leaving the wings disagreeing
  // about presence (which is read off `generation` alone). Here every write
  // names the whole pair — the initializer below and the adoption in
  // onHostSnapshot are the only two — and `DocumentIdentity`'s `readonly`
  // fields stop the pair being amended in place afterwards.
  let recorded: DocumentIdentity = { epoch: null, generation: null };
  const now = opts.now ?? (() => Date.now());
  // Rolling window of identity-transition timestamps + once-per-session latch
  // for the clustering escalation tripwire (S3b).
  const identityTransitionTimes: number[] = [];
  let resyncStormAlarmed = false;

  // The recorded pair in internal form — the ONE place `recorded` is handed out
  // as a `DocumentIdentity`, so the stamp, the drop check and the exported
  // reader all see the same shape (the two console logs read the fields direct).
  // Exported as-is; see the EditSync.recordedIdentity JSDoc. Returns a COPY, not
  // the live object: this is a public member, and `readonly` is a compile-time
  // guarantee only, so handing out a reference to internal state would let a JS
  // caller mutate this module's recorded lineage.
  const recordedIdentity = (): DocumentIdentity => ({ ...recorded });

  // Wire pair → internal pair. THE constructor for both directions — incoming
  // Documents and the pair onHostSnapshot records — so the two sides cannot
  // normalize differently. The EXCLUSIVE-pair contract is enforced at the
  // boundary validator, so a partial pair cannot arrive from a validated
  // message; normalizing one to absent is the conservative read anyway (against
  // a present recorded pair it makes presence differ → supersedes).
  const incomingIdentity = (epoch?: number, generation?: number): DocumentIdentity =>
    epoch === undefined || generation === undefined
      ? { epoch: null, generation: null }
      : { epoch, generation };

  // Stamp a captured buffer with the identity pair CURRENT at capture time. All
  // four capturing functions route through this — trySend, replayIfNeeded and
  // flush (each including its failed-post retry arm) plus cancelPendingFlush,
  // which captures without ever posting — so a buffer triggered by a foreign
  // Document, captured BEFORE onHostSnapshot records the incoming pair
  // (applyDocument calls cancelPendingFlush first), is stamped one epoch behind
  // and correctly dropped at the next drain.
  // Stamping from the incoming message instead would launder foreign-triggered
  // captures as current.
  const stampBuffer = (content: string): BufferedEdit => ({
    content,
    ...recordedIdentity(),
  });

  // Do two pairs name DIFFERENT Document identities? The ONE presence/generation
  // rule, written once: a pair-less (legacy) session on both sides is the same
  // identity, one side carrying a pair while the other does not is a transition,
  // and two present pairs differ exactly when their generations differ.
  // SYMMETRIC in its arguments — swapping them cannot change the answer — which
  // is why it keeps positional parameters while `supersedesIdentity` below,
  // whose epoch arm is directional, does not. Two judgements read it:
  // `supersedesIdentity` and `isIdentityTransition`.
  const identityChanged = (a: DocumentIdentity, b: DocumentIdentity): boolean => {
    const aPresent = a.generation !== null;
    const bPresent = b.generation !== null;
    if (!aPresent && !bPresent) {
      return false;
    }
    if (aPresent !== bPresent) {
      return true;
    }
    return a.generation !== b.generation;
  };

  // Has the host's Document lineage moved ON from `from` to `to` — i.e. is
  // content belonging to `from` no longer ours to carry forward? ONE rule at ONE
  // choke point (S3b):
  //   - both pairs absent (legacy throughout)     → no (today's behaviour)
  //   - exactly one side carries a pair           → identity transition → yes
  //   - different generation                      → identity transition → yes
  //   - same generation, `to` epoch AHEAD         → foreign bytes landed → yes
  //   - same generation, `to` epoch equal or BEHIND → no (our own lineage
  //     continues; a within-generation regression is not supersession)
  // `epoch` is compared for magnitude only WITHIN one generation; `generation`
  // is identity, never ordering (protocol.ts's DocumentMessage doc).
  //
  // DIRECTIONAL, unlike identityChanged: only the epoch arm asks which side is
  // ahead, so a swapped call inverts exactly that arm and nothing else — no type
  // error, and no symptom until a same-generation foreign advance arrives. The
  // named fields, not argument positions, are what keep the call sites readable
  // and typo-proof; the DIRECTION is held by behaviour, not by the naming.
  // Measured: swapping `from`/`to` reds 7 tests either way — the acksInFlightEdit
  // swap reds 4 in cm-edit-sync.test.ts plus 2 in editor.test.ts's (d3) block
  // and 1 in shell.test.ts; the shouldDropBufferedForEpoch swap reds 5 in
  // cm-edit-sync.test.ts plus the same 2. Do not delete those in a tidy-up.
  //
  // Two consumers read it, and they MUST agree — that is the point of sharing
  // one predicate rather than two hand-written copies. `shouldDropBufferedForEpoch`
  // decides whether a held REPLAY BUFFER survives; `acksInFlightEdit` decides
  // whether the reseed path may fold a content-echoing Document away as our ack.
  // If the display folded where the buffer is dropped, the user's ahead-of-host
  // keystrokes would stay on screen with nothing left to post them — visibly
  // present, never saved, and resurfacing on the next keystroke.
  const supersedesIdentity = ({
    from,
    to,
  }: {
    from: DocumentIdentity;
    to: DocumentIdentity;
  }): boolean => identityChanged(from, to) || (to.epoch ?? 0) > (from.epoch ?? 0);

  // Should a held buffer be dropped rather than replayed? Its STAMP is the pair
  // recorded at capture time; the currently recorded pair is where the host has
  // since got to. Replay only while the stamp's lineage still leads.
  const shouldDropBufferedForEpoch = (buf: BufferedEdit): boolean =>
    supersedesIdentity({ from: buf, to: recordedIdentity() });

  // Pure identity-transition predicate — see the EditSync.isIdentityTransition
  // JSDoc. Reads (never mutates) the recorded pair, so the shell's pre-apply
  // query and onHostSnapshot's internal call agree.
  const isIdentityTransition = (incomingEpoch?: number, incomingGeneration?: number): boolean =>
    // the first snapshot is an adoption, not a transition
    seeded &&
    identityChanged(recordedIdentity(), incomingIdentity(incomingEpoch, incomingGeneration));

  // Record an identity transition for the clustering tripwire and fire the
  // once-per-session alarm when ≥3 land within the rolling window.
  const noteIdentityTransition = (): void => {
    const t = now();
    identityTransitionTimes.push(t);
    while (
      identityTransitionTimes.length > 0 &&
      t - identityTransitionTimes[0] > IDENTITY_FLAP_WINDOW_MS
    ) {
      identityTransitionTimes.shift();
    }
    if (!resyncStormAlarmed && identityTransitionTimes.length >= IDENTITY_FLAP_THRESHOLD) {
      resyncStormAlarmed = true;
      opts.onResyncStorm?.();
    }
  };

  // Trace for the three readonly HARD DROP sites (trySend / cancelPendingFlush
  // / flush). Those are the only paths in this module that DISCARD content
  // rather than declining to replay it, so each one leaves a record — symmetric
  // with the stale-buffer drop in replayIfNeeded. Each site is reached only
  // when something is genuinely pending (trySend and cancelPendingFlush run off
  // a real doc change; flush returns early when `content === null`), so the
  // warn is unconditional: gating it on `buffered !== null` would stay silent
  // for the COMMON case — a keystroke still inside the debounce window, with
  // the buffer already nulled by the previous post — which is exactly the drop
  // worth seeing.
  //
  // Reports BOTH `liveLength` and `bufferedLength` — never picks one via `??`.
  // On the common path (no reseed in between) the live doc already contains
  // everything the buffer held, so the buffer alone under-reports the loss.
  // But a buffer that survived a host reseed (replayIfNeeded's `!canWrite`
  // guard returns without nulling it) holds bytes the host has never seen,
  // while the live doc at that point is just what the host already has —
  // so the live doc alone under-reports too. Neither value is authoritative
  // in every reachable state, so both are read straight from closure state
  // and reported side by side; callers get no `??` to pick the wrong one.
  // Length only: buffered document bytes must never reach the console.
  const warnReadonlyDrop = (site: "trySend" | "cancelPendingFlush" | "flush"): void => {
    console.warn("[quoll] dropping local change under readonly (hard drop)", {
      site,
      liveLength: opts.getDoc().length,
      bufferedLength: buffered?.content.length ?? null,
    });
  };

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
      warnReadonlyDrop("trySend");
      buffered = null;
      return;
    }
    if (!seeded || !canPost()) {
      // Gate held / pre-seed (NOT readonly): keep the content buffered
      // so a later ack or serialize-error gate clear can replay it; do not
      // drop it.
      buffered = stampBuffer(opts.getDoc());
      return;
    }
    const content = opts.getDoc();
    if (editInFlight) {
      buffered = stampBuffer(content); // single-flight: stash latest, replay on ack
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
      buffered = stampBuffer(content);
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
    // Epoch-bounded buffer validity (S3b): drop (and log) a held buffer whose
    // stamped identity is no longer live — foreign bytes landed under a
    // same-generation epoch advance, or the host identity transitioned across
    // the capture. The webview then mirrors the host's external-wins policy
    // instead of replaying stale bytes over it one round-trip later. Placed
    // BEFORE the drain guards so the buffer is simply gone by the time they run.
    if (buffered !== null && shouldDropBufferedForEpoch(buffered)) {
      // Report HOW MUCH was lost, not just which lineage lost it — the same
      // contract warnReadonlyDrop argues for, applied to this module's other
      // content-discarding path. `droppedLength` IS the loss here (unlike the
      // readonly drops, the buffer is exactly what goes); `liveLength` is what
      // the user is left looking at, and the two diverge precisely when the
      // foreign Document reseeded the view — which is the case worth triaging.
      // Length only: buffered document bytes must never reach the console.
      console.warn("[quoll] dropping stale replay buffer (foreign epoch / identity transition)", {
        stampGeneration: buffered.generation,
        stampEpoch: buffered.epoch,
        recordedGeneration: recorded.generation,
        recordedEpoch: recorded.epoch,
        droppedLength: buffered.content.length,
        liveLength: opts.getDoc().length,
      });
      buffered = null;
    }
    if (buffered === null || !seeded || editInFlight || !canWrite || !canPost()) {
      return;
    }
    const content = buffered.content;
    editInFlight = true;
    const ok = opts.post(content, docVersion);
    if (ok) {
      buffered = null;
      inFlightContent = content;
    } else {
      editInFlight = false;
      inFlightContent = null;
      buffered = stampBuffer(content);
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
    onHostSnapshot: (nextVersion, nextCanWrite, nextEpoch, nextGeneration) => {
      const transition = isIdentityTransition(nextEpoch, nextGeneration);
      // Generation-aware acceptance ordering (S3b): version order is meaningful
      // only WITHIN one host generation. On an identity transition a new host
      // session legitimately restarts at a LOWER docVersion, so SKIP the
      // stale-version early-return and adopt the incoming version/pair
      // unconditionally — matching the shell's whole-Document bypass and the
      // reducer's `adopt` bypass. Only a same-identity Document gets the ordered
      // stale drop.
      if (seeded && !transition && nextVersion < docVersion) {
        return; // stale within the same identity — shell-level guard also drops it
      }
      if (transition) {
        // Log the adoption with a triage signature (old identity → new identity)
        // BEFORE the recorded pair is overwritten, and feed the clustering
        // tripwire. The held buffer (if any) is dropped later in
        // replayIfNeeded, which compares its stamp against the new pair.
        console.info("[quoll] identity transition — adopting new host session", {
          fromGeneration: recorded.generation,
          toGeneration: nextGeneration ?? null,
          fromEpoch: recorded.epoch,
          toEpoch: nextEpoch ?? null,
        });
        noteIdentityTransition();
      }
      docVersion = nextVersion;
      canWrite = nextCanWrite;
      seeded = true;
      // Capture the identity pair alongside the version, through the SAME
      // constructor the incoming path uses. `undefined` (old host omitted the
      // pair) records as `null` — the "no epoch info" fallback that keeps a
      // pure-absent (legacy) session on today's replay behaviour — and a partial
      // pair normalizes to both-absent instead of being recorded verbatim, which
      // would leave `epoch` silently dead (presence is read off `generation`).
      recorded = incomingIdentity(nextEpoch, nextGeneration);
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
          warnReadonlyDrop("cancelPendingFlush");
          buffered = null; // readonly hard drop
        } else {
          buffered = stampBuffer(opts.getDoc());
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
      const content = hadTimer ? opts.getDoc() : (buffered?.content ?? null);
      if (content === null) {
        return; // nothing pending — genuine no-op
      }
      if (!canWrite) {
        warnReadonlyDrop("flush");
        buffered = null; // readonly hard drop (mirrors trySend)
        return;
      }
      if (!seeded || !canPost()) {
        buffered = stampBuffer(content); // pre-seed / gate closed: keep for a later drain
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
        buffered = wasInFlight ? stampBuffer(content) : null;
      } else {
        buffered = stampBuffer(content); // post failed: keep for the next ack
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
    // Ground the fold on the very buffer whose survival it predicts: replay
    // drops `buffered` iff supersedesIdentity({from: buffered, to: recorded}),
    // so reading the stamp here makes display and replay agree BY CONSTRUCTION
    // instead of via the stamp === recorded invariant, which holds only as long
    // as every accepted Document is followed by a drain. No buffer held → there
    // is nothing to carry forward, so the recorded pair is the right fallback.
    acksInFlightEdit: (content, externalEpoch, epochGeneration) =>
      inFlightContent !== null &&
      content === inFlightContent &&
      !supersedesIdentity({
        from: buffered ?? recordedIdentity(),
        to: incomingIdentity(externalEpoch, epochGeneration),
      }),
    recordedIdentity,
    isIdentityTransition,
  };
}
