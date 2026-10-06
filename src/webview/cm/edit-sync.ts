// Webview→host edit single-flight + buffer/replay, framework-free.
//
// "Framework-free" means no CodeMirror and no DOM, not zero imports: the ONE
// import is `sameTextIgnoringEol` from src/shared/, a pure helper this module
// shares with the host so the two sides cannot drift about whether the
// authoritative document still carries a given set of bytes.
//
// The host holds a write lock (QuollEditorPanel — `case "edit":` arm):
// while an Edit is applying, inbound Edits are dropped. So the webview
// posts at most ONE Edit at a time (editInFlight) and buffers the latest
// doc string for replay on the next non-stale Document ack. Text-canonical
// has no serialize step and no frontmatter side-channel — the buffered
// content is a plain Markdown string (S3b wraps it in a HeldEdit that
// also carries the capture-time (epoch, generation) identity stamp).
//
// Driven by the shell's synchronous post-commit dispatch (editor.ts +
// shell.ts):
//   - onLocalChange from the CM updateListener (debounced post).
//   - onHostSnapshot from applyDocument (records the snapshot's metadata and
//     demotes an in-flight Edit the Document does not carry into the replay
//     buffer — never touches editInFlight, never drains).
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

import { sameTextIgnoringEol } from "../../shared/text-equality.js";

const DEBOUNCE_MS = 300;

// Clustering escalation tripwire (S3b): ≥3 identity transitions within this
// rolling window fire ONE per-session low-alarm notice. Defence-in-depth for
// the acknowledged straggler-storm residual — surfaces a silently-repeating
// resync to the user (log-only is insufficient; the S4 abort-toast precedent).
const IDENTITY_FLAP_WINDOW_MS = 5 * 60 * 1000;
const IDENTITY_FLAP_THRESHOLD = 3;

/** UN-ACKED local content plus the (epoch, generation) identity pair recorded
 *  when it was captured or posted (S3b). TWO holders share this ONE shape
 *  because ONE lineage rule (`supersedesIdentity`) reads both stamps — while the
 *  LOSS judgement (`lostToSupersession`) is applied to exactly ONE of them, the
 *  NEWEST held content (see the drain: OR-ing per-holder verdicts only adds false
 *  positives):
 *    - `buffered` — waiting to be (re)posted; dropped by
 *      `shouldDropBufferedForEpoch`. Either captured pre-ack, or DEMOTED from
 *      `inFlight` by `onHostSnapshot` when a Document on the same lineage
 *      arrived without those bytes — posted, but not known to have landed.
 *    - `inFlight` — already posted; cleared by the next accepted Document's
 *      commit in `onReducerCommit`, which hands the settled value to the drain
 *      as evidence. That Document is not necessarily THIS Edit's ack — a
 *      Document carries no correlation to an Edit — which is why the demotion
 *      above exists: without it the bytes would have no carrier once cleared.
 *  Together with the debounce timer these are the only carriers of bytes the
 *  view shows ahead of the host.
 *  `replayIfNeeded` compares a stamp against the currently recorded pair and
 *  DROPS the buffer on a foreign epoch advance or any identity transition — the
 *  webview then mirrors the host's external-wins policy instead of clobbering it
 *  one round-trip later. The stamp is what binds a judgement to the lineage the
 *  bytes actually belonged to: `recorded` is NOT guaranteed to sit still while an
 *  Edit is in flight (onHostSnapshot can accept another Document first), so
 *  reading the live pair instead would judge the wrong lineage.
 *  `epoch`/`generation` are `null` when captured before the first host snapshot.
 *  `content` is `readonly` for the same reason `DocumentIdentity`'s fields are: a
 *  HeldEdit is built WHOLE by `stampHeld`, so the stamp and the content belong to
 *  one capture and neither wing may be replaced on its own. */
type HeldEdit = DocumentIdentity & { readonly content: string };

/** A Document's (externalEpoch, epochGeneration) pair in edit-sync's internal
 *  form. The wire pair is required (see protocol.ts); `null` on BOTH fields
 *  means only "before the first host snapshot".
 *  Both fields are `readonly`: a pair is REPLACED as a whole, never amended one
 *  wing at a time, so "advance the epoch and leave the generation behind"
 *  cannot be written. (Where the recorded pair's writes live is recorded at its
 *  declaration, not duplicated here — a second copy is what drifts.)
 *  Constructing a half-pair LITERAL still type-checks — closing that needs a
 *  sum type, which costs more test churn than the hole is worth. */
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
   *  surfaces a low-alarm user-visible notice; the shell owns the wording
   *  (`NOTICE_TEXT.storm` in shell.ts) and the display-side latch. Never fired
   *  per-transition; latched after the first alarm. Defaults to a no-op. */
  onResyncStorm?: () => void;
  /** Fired from the drain when un-acked local bytes were actually LOST, from
   *  either of the two holders this module carries them in — a held pre-ack
   *  replay buffer, or an Edit still awaiting its ack. "Lost" is ONE rule
   *  (`lostToSupersession`) applied to ONE subject (the NEWEST held content):
   *  the host's Document lineage moved on from its stamp AND the authoritative
   *  document does not carry it. A superseded holder whose bytes the document
   *  still carries is NOT a loss and does NOT fire this — a byte-identical
   *  foreign write, a foreign write equal to the user's latest keystrokes, a
   *  `flush()` force-post the host echoes back, an EOL-only skew — because a
   *  notice that names losses which did not happen is how a real one gets
   *  ignored.
   *  When it does fire, those bytes are gone: the reseed transaction carries
   *  `Transaction.addToHistory.of(false)`, so Undo cannot bring them back, and
   *  the host answers a `stale` Edit by reposting the authoritative Document
   *  rather than with an `edit-rejected` banner, so nothing else would say so.
   *  A `console.warn` beside each holder's discard (the buffer drop and the
   *  in-flight discard, one per drain) is the triage signal (lengths, lineage);
   *  this callback is the USER-visible one — the shell renders a notice. At most
   *  ONE call per drain, NOT latched here: "is a notice already on screen" is
   *  only knowable on the display side, so the aggregation rule lives in
   *  shell.ts. Zero arguments by design — the notice says the same thing
   *  regardless of how much was lost.
   *
   *  CALLED AFTER both holders have settled, and wrapped in a local try/catch —
   *  see the call site for why the two halves are independent.
   *  Defaults to a no-op. */
  onLocalEditDiscarded?: () => void;
  /** Make the VIEW show `content`. Called from the drain, always with
   *  `buffered.content`, when the document is writable and the view does not
   *  show the newest held bytes — a readonly Document rewound it and write has
   *  since been re-granted, or an in-flight Edit was demoted under a Document
   *  that reseeded. Without it the replay would reach the host while the screen
   *  stayed behind, and the next keystroke — typed from the stale view — would
   *  post a document missing those bytes.
   *  The implementation must apply it as a host reseed, not as a user edit
   *  (non-history, and not read back through `onLocalChange`).
   *  MUST NEVER RUN INSIDE A CODEMIRROR UPDATE: it dispatches on the view. The
   *  only drain reachable from the update listener is the one driven by
   *  `local-edit-attempt`, and that dispatch is preceded by `discardBuffer()`,
   *  so the drain finds no buffer and never gets here.
   *  NOT called while a debounce timer is live: the view then holds a keystroke
   *  this module has not captured yet, and a drain that is not a Document's (a
   *  theme change, `edit-rejected`, a gate clear — none of them cancels the
   *  timer first) would overwrite it.
   *  NOT called while the serialize-error gate (`canPost`) is closed. A drain
   *  that finds it closed is never a Document's — the reducer's `document` arm
   *  always clears the gate — so the view has not been rewound; it can only be
   *  AHEAD of the buffer. That is the drain a failing `post` re-enters, before
   *  the bytes being posted have been stamped, and showing the older buffer
   *  there would rewind the view behind the keystroke that just failed to send.
   *  A throw is caught at the call site and logged, and that drain posts
   *  nothing; the buffer is kept for the next one.
   *  Unset → the view is left as it is and the replay proceeds. */
  showHeld?: (content: string) => void;
  /** Fired from `flush` — and ONLY from `flush` — when the document is readonly
   *  and this module is HOLDING un-posted edits from before the flip that the
   *  host's document does not carry. What it claims, and no more: the edits are
   *  held, they replay if write is re-granted, and they are gone if the editor
   *  closes first (the buffer lives in this iframe). It does NOT claim they are
   *  lost, and nothing here makes them durable.
   *  SHOWN at most once per readonly episode — latched here, unlike
   *  `onLocalEditDiscarded`: a discard is a fresh event each time, whereas a hold
   *  is a STATE and `flush` runs on every blur, so an unlatched hold would
   *  re-raise a dismissed notice on each focus change. The latch re-arms when a
   *  snapshot grants write.
   *  Returns whether the notice reached the user. `false` — the caller declined
   *  to show it (the shell's slot holds a stronger claim) — does NOT spend the
   *  latch, so the next `flush` asks again for as long as the hold is still
   *  true; otherwise an episode could end with the hold never shown. Only an
   *  explicit `false` retries: a throw counts as shown, because a notifier that
   *  failed part-way may have drawn the notice, and retrying a persistently
   *  throwing one would log on every blur.
   *  The console trace of the hold does not follow this answer: it is written
   *  once per readonly episode, before the call, so a hold whose notice is
   *  declined until the editor closes still leaves a record.
   *  Why `flush` and not the drain at flip time: a transient readonly that
   *  re-grants at once would flash a notice for edits that are about to replay.
   *  `flush` runs when the user leaves the editor, which is when held edits
   *  become at risk.
   *  A change made WHILE readonly never fires this — it is dropped with a
   *  console trace only (see `warnReadonlyDrop`).
   *  Wrapped in a local try/catch: a failed notice must not escape into the
   *  teardown listeners that call `flush`. Unset counts as shown. */
  onReadonlyHold?: () => boolean;
};

export type EditSync = {
  /** Editor content changed locally (CM updateListener docChanged). */
  onLocalChange: () => void;
  /** A host Document arrived. Records its metadata — the version + canWrite
   *  edit-sync echoes on the next Edit, and the identity pair — and DEMOTES an
   *  un-acked in-flight Edit into the replay buffer when `content` does not
   *  carry it (below). Does NOT touch editInFlight and does NOT drain (that is
   *  onReducerCommit's job).
   *  Stale (older docVersion) Documents are ignored ONLY within one host
   *  identity: on an identity transition (and before the first snapshot) the
   *  incoming version/pair is adopted unconditionally, because version ordering
   *  is meaningful only within one generation (S3b). `canWrite` is the
   *  FRESH value threaded from message.canWrite. Called synchronously
   *  from applyDocument.
   *
   *  DEMOTION. The reducer treats every accepted Document as the ack of the
   *  Edit in flight, and `onReducerCommit` then clears the in-flight holder.
   *  But the host does not answer Edits one-to-one: the Document may be the ack
   *  of an EARLIER Edit, a stale repost, or a refusal of the one in flight, and
   *  nothing on the wire tells them apart. So when nothing newer is buffered,
   *  the Document continues the in-flight Edit's lineage, and `content` is not
   *  its text (EOL aside), the in-flight Edit BECOMES the buffer — its bytes
   *  keep a carrier instead of being forgotten by the commit that follows.
   *  Done HERE rather than in the drain because this is the one entry only a
   *  Document reaches. The drain also runs for `edit-rejected`, where the host
   *  has said no to exactly those bytes and they must NOT be re-buffered.
   *  A stale Document (the early return above) demotes nothing.
   *
   *  RESPONSIBILITY SPLIT: a single Document carries TWO host signals
   *  that an earlier `onDocument` conflated — "here is the current
   *  snapshot" (metadata + reseed) and "I acked your in-flight Edit"
   *  (clear editInFlight + drain). Conflating them created a two-state
   *  divergence (historically a parse-failure Document cleared edit-sync's
   *  editInFlight while the reducer left state.editInFlight untouched —
   *  the parse-failure path is retired as of C8) and missed
   *  same-docVersion acks. The
   *  split: onHostSnapshot records metadata (and re-homes the in-flight
   *  Edit's BYTES by demotion, above) but never touches the in-flight FLAG;
   *  the reducer's `state.editInFlight` is the SINGLE source of truth, passed
   *  into onReducerCommit, which is the only thing that clears edit-sync's
   *  flag + drains. So edit-sync never derives in-flight from a Document
   *  arrival. */
  onHostSnapshot: (
    docVersion: number,
    canWrite: boolean,
    externalEpoch: number,
    epochGeneration: number,
    content: string
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
   *  currently readonly, in which case that in-window change is dropped
   *  uncaptured (see `warnReadonlyDrop`), mirroring `trySend`. A buffer
   *  already held from before the readonly flip is left untouched. */
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
   *      buffer on its own post, so it is exactly ONE replay). An ack that does
   *      NOT advance the version replays nothing — the drain never re-posts the
   *      (content, base) pair this force-post just used — and the buffer waits
   *      for the next version. Meanwhile the view shows the retained bytes, so
   *      the earlier Edit's ack folds instead of rewinding it. On a real close
   *      the retained buffer is simply never replayed (iframe gone).
   *    - Nothing in flight → NULL (like trySend's idle post). The force-post
   *      lands at a matching version and is `accept`ed outright, so the host is
   *      already the authority for those bytes; retaining them would serve no
   *      recovery purpose and could later replay already-applied content over a
   *      racing EXTERNAL edit — the host has no client-side conflict guard for a
   *      post-settlement replay, so that would silently clobber the external
   *      change.
   *
   *  Posts NOTHING under readonly: a change still inside the debounce window is
   *  dropped (see `warnReadonlyDrop`), while a buffer held from before the flip
   *  is KEPT for a re-grant to replay and announced through `onReadonlyHold`
   *  until that notice has been shown once. Before the first snapshot `canWrite`
   *  is still false, so the same arm runs: an in-window change is dropped with
   *  the same console trace, but NO notice fires, and a pre-seed capture
   *  (cancelPendingFlush) is left for the seed's drain to judge.
   *  Two other cases keep the buffer WITHOUT posting and without any notice: the
   *  serialize-error gate is closed, or the post itself fails.
   *  NEVER deduped against the last post, unlike the drain: a teardown signal
   *  is a new trigger, and it is the retry for bytes the drain is holding back
   *  after a host refusal.
   *  NOT a mid-session call — for a reseed always use `cancelPendingFlush`
   *  (capture-preserving), never `flush`. */
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
  /** Is the VIEW showing the newest bytes this webview still holds un-acked, on
   *  a lineage that still leads? TWO conditions, deliberately answered by ONE
   *  call so a caller cannot check half of it:
   *
   *  1. `liveDoc` (the view, serialised) carries the same TEXT as the NEWEST
   *     holder — the replay buffer when one is held, the in-flight Edit
   *     otherwise — line endings aside (`sameTextIgnoringEol`: bytes held
   *     across an EOL-mode switch still carry the old EOL). False when nothing
   *     is held, and false when the view has moved off the held bytes.
   *  2. The incoming Document's identity pair CONTINUES that holder's lineage —
   *     same generation with the epoch not advanced. Pass the incoming pair
   *     BEFORE `onHostSnapshot` records it (applyDocument's order).
   *
   *  The reseed path (editor.ts applyDocument) uses this to decide whether a
   *  Document that differs from the view may replace it. The question is
   *  deliberately about the VIEW, not about whether the Document echoes the
   *  in-flight Edit: a Document carries no correlation to an Edit, so the ack
   *  of an earlier Edit, a stale repost and a refusal all arrive as "same
   *  lineage, not my in-flight bytes". Reseeding on any of them rewinds the
   *  screen behind bytes that are still held, and the next keystroke — typed
   *  from the rewound view — forks off them. While the view shows the newest
   *  held bytes there is nothing on screen that lacks a carrier, so the
   *  Document folds into version bookkeeping and the holder goes forward on
   *  the drain.
   *  Condition 2 is what keeps that true: it holds the fold to exactly the
   *  Documents whose buffer `replayIfNeeded` will still replay. On a
   *  superseded lineage the buffer is DROPPED, so folding there would leave
   *  the ahead keystrokes visible but unsavable.
   *  What it cannot see: a same-epoch Document carrying content that is not
   *  ours also folds. See the residuals in `replayIfNeeded`. */
  viewHoldsUnackedEdit: (
    liveDoc: string,
    externalEpoch: number,
    epochGeneration: number
  ) => boolean;
  /** The Document identity pair (externalEpoch, epochGeneration) recorded from
   *  the most recent accepted host snapshot — `null` before the first snapshot.
   *  It is the replay side's half of the shared `supersedesIdentity` rule:
   *  `shouldDropBufferedForEpoch` compares a holder's stamp against it and drops
   *  a held buffer on a foreign epoch advance or an identity transition. The
   *  display side (`viewHoldsUnackedEdit`, which gates the reseed path's fold)
   *  asks the same rule about the same stamp against the INCOMING pair, before
   *  it is recorded here — so the two agree once it is. See
   *  `supersedesIdentity`. */
  recordedIdentity: () => DocumentIdentity;
  /** Pure predicate (no side effects): would an incoming Document's identity
   *  pair be an identity transition against the CURRENTLY recorded pair? True
   *  on a different generation; false for a same-generation Document or before
   *  the first snapshot (the seed is an adoption, not a transition). The shell
   *  reads this BEFORE `applyDocument` to bypass its whole-Document
   *  stale-version drop on a transition; `onHostSnapshot` recomputes it
   *  internally to bypass its own stale guard, count the tripwire, and adopt the
   *  pair (both read the same unchanged recorded pair, so they agree). Version
   *  ordering is meaningful only WITHIN one host generation (S3b). */
  isIdentityTransition: (externalEpoch: number, epochGeneration: number) => boolean;
};

export function createEditSync(opts: EditSyncOptions): EditSync {
  const canPost = opts.canPost ?? (() => true);
  let docVersion = 0;
  let seeded = false;
  let canWrite = false;
  let editInFlight = false;
  // The Edit currently awaiting its ack. Paired with `editInFlight` at every
  // assignment site — but NOT interchangeable with `inFlight !== null`, and not
  // derivable from it: both trySend and replayIfNeeded raise `editInFlight`
  // BEFORE `opts.post()` and stamp `inFlight` only after it returns (flush reads
  // the pre-post flag as `wasInFlight`), and `post` can re-enter this module
  // synchronously — `postEditMessage` dispatches `serialize-error`, whose
  // committed state is `editInFlight: false`, which drives a re-entrant
  // onReducerCommit -> drain from inside that call. So the pairing holds BETWEEN
  // statements at every assignment site, not DURING the post: the flag is the
  // single-flight gate across that window and the holder is the evidence.
  // Collapsing one into the other was proposed and rejected in review — any
  // collapse has to pick an ordering, and thereby change what that re-entrant
  // reader observes mid-post (stamping before the post would make
  // `viewHoldsUnackedEdit` answer true for bytes not yet posted). That is a
  // behaviour change, not a refactor.
  // STAMPED, like the buffer: `viewHoldsUnackedEdit` reads its content and stamp
  // when no buffer is held, `onHostSnapshot` reads both to decide a demotion,
  // and the drain reads its stamp to ask whether the host's lineage moved on
  // without carrying those bytes. Cleared by `onReducerCommit` alongside
  // `editInFlight` — the two stay paired in ONE function — which hands the
  // settled value to the drain as evidence.
  let inFlight: HeldEdit | null = null;
  let buffered: HeldEdit | null = null;
  // The (content, baseDocVersion) pair of the last post that SUCCEEDED, so the
  // drain never re-posts it by itself. Why: a host refusal and a stale repost
  // are indistinguishable on the wire — both arrive as a Document on our
  // lineage that does not carry the posted bytes, at an unchanged version — and
  // both demote those bytes back into the buffer. Replaying them at the same
  // base would get the same answer, which would demote and replay them again:
  // a post loop with the host. So an identical pair waits for something to
  // change — a version advance, a keystroke, a teardown flush.
  // Written ONLY when `post` returned true (`notePost`, from all three posting
  // sites): a post that failed never reached the host, so its retry must not be
  // deduped away. Reset in `onHostSnapshot` when the lineage moves or write is
  // re-granted — an answer given under the old lineage / capability predicts
  // nothing about the new one.
  let lastPost: { readonly content: string; readonly baseDocVersion: number } | null = null;
  // Call AFTER a successful post and before anything can move `docVersion`:
  // the base recorded is the one that post carried.
  const notePost = (content: string): void => {
    lastPost = { content, baseDocVersion: docVersion };
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Document identity pair from the most recent accepted host snapshot (S3a
  // recorded it; S3b now acts on it). Both fields are `null` before the first
  // snapshot. Read in replayIfNeeded's drop check, at each buffer capture (via
  // stampHeld), by isIdentityTransition, and by onHostSnapshot itself (has the
  // lineage moved since the last post; does the in-flight Edit still belong to
  // it). The display side (`viewHoldsUnackedEdit`) does NOT read it: it runs
  // before the incoming pair is recorded and compares a holder's stamp against
  // that incoming pair directly.
  // ONE variable holding the PAIR, not two independent wings: with two `let`s a
  // write could land on one and miss the other, leaving the wings disagreeing.
  // Here every write names the whole pair — the initializer below and the
  // adoption in onHostSnapshot are the only two — and `DocumentIdentity`'s
  // `readonly` fields stop the pair being amended in place afterwards.
  let recorded: DocumentIdentity = { epoch: null, generation: null };
  const now = opts.now ?? (() => Date.now());
  // Rolling window of identity-transition timestamps + once-per-session latch
  // for the clustering escalation tripwire (S3b).
  const identityTransitionTimes: number[] = [];
  let resyncStormAlarmed = false;

  // The recorded pair in internal form — the ONE place `recorded` is handed out
  // as a `DocumentIdentity`, so every reader listed at its declaration above
  // sees the same shape (the three console logs — the buffer drop, the in-flight
  // discard, and the identity-transition adoption — read the fields direct; that
  // list is not repeated here, because a second copy is what goes stale).
  // Exported as-is; see the EditSync.recordedIdentity JSDoc. Returns a COPY, not
  // the live object: this is a public member, and `readonly` is a compile-time
  // guarantee only, so handing out a reference to internal state would let a JS
  // caller mutate this module's recorded lineage.
  const recordedIdentity = (): DocumentIdentity => ({ ...recorded });

  // Stamp a captured buffer with the identity pair CURRENT at capture time. All
  // four capturing functions route through this — trySend, replayIfNeeded and
  // flush (each including its failed-post retry arm) plus cancelPendingFlush,
  // which captures without ever posting — so a buffer triggered by a foreign
  // Document, captured BEFORE onHostSnapshot records the incoming pair
  // (applyDocument calls cancelPendingFlush first), is stamped one epoch behind
  // and correctly dropped at the next drain.
  // Stamping from the incoming message instead would launder foreign-triggered
  // captures as current.
  const stampHeld = (content: string): HeldEdit => ({
    content,
    ...recordedIdentity(),
  });

  // Has the host's Document lineage moved ON from `from` to `to` — i.e. is
  // content belonging to `from` no longer ours to carry forward? ONE rule at ONE
  // choke point (S3b):
  //   - different generation (incl. a pre-seed `null` stamp) → identity
  //     transition → yes
  //   - same generation, `to` epoch AHEAD         → foreign bytes landed → yes
  //   - same generation, `to` epoch equal or BEHIND → no (our own lineage
  //     continues; a within-generation regression is not supersession)
  // `epoch` is compared for magnitude only WITHIN one generation; `generation`
  // is identity, never ordering (protocol.ts's DocumentMessage doc).
  //
  // DIRECTIONAL: only the epoch arm asks which side is ahead, so a swapped call
  // inverts exactly that arm and nothing else — no type error, and no symptom
  // until a same-generation foreign advance arrives. The named fields, not
  // argument positions, are what keep the call sites readable and typo-proof;
  // the DIRECTION is held by behaviour, not by the naming.
  // Measured, one call site at a time, against cm-edit-sync.test.ts,
  // editor.test.ts and shell.test.ts: swapping `from`/`to` in
  // `shouldDropBufferedForEpoch` or in `viewHoldsUnackedEdit` reds tests by the
  // dozen; each of the two calls in `onHostSnapshot` is held by exactly ONE
  // test — the `lastPost` reset by "a foreign epoch advance: the same (content,
  // base) typed on the new lineage is posted", the demotion only by a console
  // trace assertion ("reports both lineage pairs and both lengths … when the
  // in-flight Edit is lost"). Those tests are what hold the direction — do not
  // delete them in a tidy-up.
  //
  // Every lineage decision in this module reads it, and they MUST agree — that
  // is the point of sharing one predicate rather than hand-written copies:
  //   - `shouldDropBufferedForEpoch` — does a held REPLAY BUFFER survive?
  //   - `viewHoldsUnackedEdit` — may the reseed path fold a Document away
  //     instead of replacing a view that shows held bytes?
  //   - `onHostSnapshot` — may an in-flight Edit be demoted into the buffer, and
  //     is the last post's verdict still about this lineage?
  // If the display folded where the buffer is dropped, the user's ahead-of-host
  // keystrokes would stay on screen with nothing left to post them — visibly
  // present, never saved, and resurfacing on the next keystroke. A demotion
  // across a superseded lineage would only manufacture a buffer for the next
  // drain to drop.
  const supersedesIdentity = ({
    from,
    to,
  }: {
    from: DocumentIdentity;
    to: DocumentIdentity;
  }): boolean => from.generation !== to.generation || (to.epoch ?? 0) > (from.epoch ?? 0);

  // Has the host's lineage moved on from these HELD bytes? Its STAMP is the pair
  // recorded at capture time; the currently recorded pair is where the host has
  // since got to. TWO callers, one per holder, and the question is holder-neutral
  // even though the name is not: the replay side drops `buffered` when this is
  // true (replay only while the stamp's lineage still leads), and
  // `lostToSupersession` asks the same question of the SETTLED IN-FLIGHT Edit,
  // which has no replay to decline — `onReducerCommit` already cleared it. Do not
  // reuse this as a buffer-only predicate.
  const shouldDropBufferedForEpoch = (held: HeldEdit): boolean =>
    supersedesIdentity({ from: held, to: recordedIdentity() });

  // Were these un-acked local bytes actually LOST? Applied to the NEWEST held
  // content and nothing else (see the drain). TWO conditions, and the second is
  // what separates a loss from mere bookkeeping:
  //   - the host's Document lineage has moved ON from the stamp — the SAME
  //     predicate the replay side drops a buffer on, so display and replay
  //     cannot disagree about which lineage still leads; and
  //   - the authoritative document does not carry the bytes.
  // The content test is EOL-INSENSITIVE, through the same `sameTextIgnoringEol`
  // the host's `contentMatches` asks of this document (src/shared/) — one
  // definition, so the two sides cannot drift apart about what "carries these
  // bytes" means. In this module it is asked here (the loss judgement), in
  // `viewHoldsUnackedEdit` (does the view show the held bytes?), in the demotion
  // (does the Document carry the in-flight bytes?), before `showHeld` (is the
  // view already there?) and in `noteReadonlyHold` (does the host already carry
  // the held bytes?) — never to decide WHAT bytes to post, and never by the
  // post dedupe, which compares exact strings: the host canonicalises a Document
  // to `document.eol` while this side posts whatever its `quollDocumentEol`
  // facet holds. The facet takes the wire
  // `eol`, so the two agree in steady state, but bytes held across an EOL-mode
  // switch still carry
  // the old EOL — an EOL-only difference is skew between the two sides, and
  // reporting it as a lost edit trains the user to ignore a notice that
  // otherwise only fires on real loss.
  // `opts.getDoc()` IS that authoritative content whenever the first condition
  // holds, which is why the judgement reads the view instead of keeping a copy
  // of the Document's content: supersession makes `viewHoldsUnackedEdit` false
  // (its lineage conjunct is this same rule on this same stamp), so `foldsOkAck`
  // is false, so applyDocument either reseeded the view to the host's bytes or
  // the live doc already equalled them (`aheadOfHost === false`). There is no
  // third branch — a `canWrite: false` Document reseeds too
  // (`needsReseed = aheadOfHost && !foldsOkAck`) — and `showHeld` cannot have
  // moved the view since: it runs later in the drain, and only for a buffer
  // that SURVIVED the drop.
  // What the TRUE verdict does and does not claim: the document is not carrying
  // the user's bytes AS WRITTEN. Whether they were never applied, applied and
  // then overwritten, or applied and then added to is NOT decidable here (a
  // Document carries no applied/rejected flag, and the host bumps the epoch in
  // every one of those readings) — which is what the shipped notice says: review
  // recent changes and reapply anything missing.
  const lostToSupersession = (held: HeldEdit): boolean =>
    shouldDropBufferedForEpoch(held) && !sameTextIgnoringEol(held.content, opts.getDoc());

  // Pure identity-transition predicate — see the EditSync.isIdentityTransition
  // JSDoc. Reads (never mutates) the recorded pair, so the shell's pre-apply
  // query and onHostSnapshot's internal call agree.
  const isIdentityTransition = (_incomingEpoch: number, incomingGeneration: number): boolean =>
    // the first snapshot is an adoption, not a transition
    seeded && recorded.generation !== incomingGeneration;

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
      resyncStormAlarmed = true; // latched BEFORE the call: no retry either way
      // Same contract as the drain's `onLocalEditDiscarded` call site — a failed
      // NOTICE must not take the sync loop down. It matters MORE here: this runs
      // from onHostSnapshot BEFORE the incoming version / canWrite / seeded /
      // recorded pair are adopted, so an escaping throw would leave `recorded` a
      // generation behind (the next drain would then replay a stale buffer over
      // the foreign bytes — the clobber S3b exists to prevent), leave the
      // reducer's editInFlight latched, and escape into host.ts's unguarded
      // message `handler()`.
      try {
        opts.onResyncStorm?.();
      } catch (err) {
        console.error("[quoll] onResyncStorm threw", err);
      }
    }
  };

  // Trace for the three readonly drop sites (trySend / cancelPendingFlush /
  // flush). Each DISCARDS the live change — the docChanged that reached it —
  // rather than declining to replay it, so each leaves a record, symmetric with
  // the stale-buffer drop in replayIfNeeded. None of them touches `buffered`.
  //
  // Why the live change may go and the buffer may not: the Compartment makes a
  // `canWrite=false` doc genuinely non-editable, so a docChanged under readonly
  // can only be programmatic, and retaining it would let a later write-granting
  // ack replay content that was never legitimately editable. `buffered`, when
  // non-null after the seed, is the opposite — every site that CAPTURES into it
  // requires `canWrite`, and the one site that fills it without that check (the
  // demotion in `onHostSnapshot`) moves an `inFlight` Edit, which was itself
  // posted behind a `canWrite` check — so it holds bytes typed while writable
  // that the host has not ACKED. Not necessarily un-applied: flush's retain arm
  // keeps bytes it just force-posted, which the host may well carry —
  // `noteReadonlyHold` checks.
  //
  // ASSUMPTION, held outside this module: a debounce timer that is live while
  // readonly was SCHEDULED under readonly. `canWrite` changes only in
  // onHostSnapshot, and its one production caller (editor.ts applyDocument)
  // calls cancelPendingFlush first, which always clears the timer — so a
  // writable-era keystroke is captured into the buffer before the flip and
  // never rides a timer across it. Reordering applyDocument would break that.
  //
  // trySend and cancelPendingFlush run off a real doc change and flush warns
  // only when it found a live timer, so the warn is unconditional at each site:
  // gating it on `buffered !== null` would stay silent for the common case, a
  // change still inside the debounce window with nothing buffered.
  //
  // Reports BOTH lengths — never one picked via `??`. `liveLength` is the doc
  // carrying the dropped change; `bufferedLength` is the RETAINED buffer (null
  // when none is held), which says whether writable-era bytes are still waiting
  // behind this drop. Neither stands in for the other.
  // Length only: buffered document bytes must never reach the console.
  const warnReadonlyDrop = (site: "trySend" | "cancelPendingFlush" | "flush"): void => {
    console.warn("[quoll] dropping local change under readonly (hard drop)", {
      site,
      liveLength: opts.getDoc().length,
      bufferedLength: buffered?.content.length ?? null,
    });
  };

  // The user-visible half of the readonly hold, called from `flush` only (the
  // rationale for that, and for the latch, is on `EditSyncOptions.onReadonlyHold`).
  // Under readonly no capture site runs, so the buffer cannot be replaced: one
  // shown notice per readonly episode is one per held buffer. (A demotion can
  // FILL an empty buffer under readonly — the readonly Document answering an
  // in-flight Edit without its bytes — which is the hold this announces.)
  // What happens to the hold on a re-grant is the drain's business: it brings
  // the view forward to the held bytes (`showHeld`) and replays them.
  // Two latches, both per episode: the notice's can be handed back by a
  // declining notifier, the console trace's cannot — the trace records that a
  // hold EXISTS, whether or not the user has been told yet.
  let readonlyHoldAnnounced = false;
  let readonlyHoldTraced = false;
  const noteReadonlyHold = (): void => {
    // `seeded`: `canWrite` starts false, but "readonly" means nothing until the
    // host has said so — a pre-seed capture is not a held writable-era edit.
    if (!seeded || buffered === null || readonlyHoldAnnounced) {
      return;
    }
    // The host already carries these bytes → nothing is at risk, so say nothing
    // and do NOT spend the latch (a later readonly Document can still rewind
    // the view past them). Under readonly the live doc IS the host's content —
    // a `canWrite: false` Document never folds, and `showHeld` only runs while
    // writable — which makes it the authoritative comparison, the same reading
    // `lostToSupersession` relies on.
    const liveDoc = opts.getDoc();
    if (sameTextIgnoringEol(buffered.content, liveDoc)) {
      return;
    }
    // Latched BEFORE the call: that is what answers a notifier that
    // synchronously re-enters `flush`.
    readonlyHoldAnnounced = true;
    // Traced BEFORE the call and regardless of its answer: one record per
    // episode, at the first flush that sees the hold. A notice can wait behind
    // a stronger one for the whole episode, and an editor closed in that window
    // would otherwise leave nothing saying edits were being held. Never written
    // after the call — a notifier that re-enters a re-grant has already re-armed
    // it for the next episode.
    // Length only: buffered document bytes must never reach the console.
    if (!readonlyHoldTraced) {
      readonlyHoldTraced = true;
      console.warn(
        "[quoll] holding un-posted edits under readonly (replays if write is re-granted)",
        { heldLength: buffered.content.length, liveLength: liveDoc.length }
      );
    }
    // The catch answers a notifier that throws: `flush` is called from bare DOM
    // listeners (shell.ts), so an escaping throw would surface as an
    // unattributed uncaught error. A throw leaves `declined` false — the latch
    // stays spent (see `EditSyncOptions.onReadonlyHold`).
    let declined = false;
    try {
      declined = opts.onReadonlyHold?.() === false;
    } catch (err) {
      console.error("[quoll] onReadonlyHold threw", err);
    }
    if (declined) {
      // Not shown: give the next flush another try. This only ever writes
      // `false`, so it cannot undo a re-grant the notifier re-entered into.
      readonlyHoldAnnounced = false;
    }
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
    // Readonly DROPS this change rather than buffering it: it can only be
    // programmatic, and this layer is the last defense against replaying it
    // once write returns (see `warnReadonlyDrop`). `buffered` is deliberately
    // not touched — whatever it holds was typed while writable.
    // cancelPendingFlush's `seeded && !canWrite` branch mirrors this.
    if (!canWrite) {
      warnReadonlyDrop("trySend");
      return;
    }
    if (!seeded || !canPost()) {
      // Gate held / pre-seed (NOT readonly): keep the content buffered
      // so a later ack or serialize-error gate clear can replay it; do not
      // drop it.
      buffered = stampHeld(opts.getDoc());
      return;
    }
    const content = opts.getDoc();
    if (editInFlight) {
      buffered = stampHeld(content); // single-flight: stash latest, replay on ack
      return;
    }
    editInFlight = true;
    const ok = opts.post(content, docVersion);
    if (ok) {
      buffered = null;
      inFlight = stampHeld(content);
      notePost(content);
    } else {
      // postMessage threw: drop the in-flight flag so a later ack/change
      // can retry, and retain the buffered content.
      editInFlight = false;
      inFlight = null;
      buffered = stampHeld(content);
    }
  };

  const replayIfNeeded = (settledInFlight: HeldEdit | null): void => {
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
    // ONE subject, ONE rule, ONE notice per drain. The subject is the NEWEST
    // un-acked local content: the replay buffer when one is held, and the Edit
    // the ack just settled otherwise. The two holders are ORDERED — every site
    // that buffers while an Edit is in flight reads the live doc AFTER that post,
    // and flush's retain arm stamps the bytes it just posted — so `buffered` is
    // normally a descendant of, or identical to, `settledInFlight`. Judging them
    // independently and OR-ing the verdicts can only ADD false positives: two
    // reviewers measured one on `post("a") -> buffer("ab") -> Document("ab") at a
    // new epoch`, where the buffer survives the content test and the ancestor
    // snapshot "a" fails it — announcing a discard with every character of the
    // user's text still on screen and on disk. If the NEWEST bytes survived,
    // there is nothing to reapply, whatever became of an older snapshot.
    //
    // What keeps the ordering true — three invariants, each held by one
    // mechanism:
    //   I1 (no rewind). While writable, on a lineage that still leads, a
    //      Document never replaces a view that shows the newest held bytes
    //      (`viewHoldsUnackedEdit`, which gates applyDocument's fold). So a
    //      keystroke is always typed on top of what is held, never beside it.
    //   I2 (carrier). Bytes the view shows ahead of the host are in the debounce
    //      timer, in `buffered`, or in `inFlight` (the demotion in
    //      `onHostSnapshot` covers the Document that settles an in-flight Edit
    //      without carrying it; `showHeld` below covers the converse — held
    //      bytes the view stopped showing). The one exception is a draft the
    //      host answered with `edit-rejected`: it stays on screen behind the
    //      serialize-error banner, deliberately without a carrier.
    //   I3 (no automatic identical retry). This drain never re-posts a
    //      (content, baseDocVersion) pair it already posted unless the lineage
    //      moved or write was re-granted in between (`lastPost`). A keystroke or
    //      a teardown `flush` is a new trigger and is not deduped.
    //
    // RESIDUALS — stated, not handled. The first two need the protocol to
    // correlate a Document with the Edit it answers, which the wire does not
    // carry today:
    //   - Same-epoch content this webview cannot tie to its own held bytes. The
    //     host has paths that deliver foreign bytes WITHOUT an epoch advance
    //     (host-session-core's own ACCEPTED RESIDUALs: an unobserved settle, a
    //     failed settlement transition). ANY such Document is treated as
    //     own-lineage — including a late arrival of content posted long ago and
    //     no longer held — so the fold keeps the user's view over it and the
    //     held bytes are replayed over it, silently. Every OTHER same-epoch
    //     Document that is not the held bytes (a refusal, a stale or no-op
    //     repost, the Document behind a rejected draft) IS own-lineage, where
    //     keeping the user's bytes is the right outcome; the two cannot be told
    //     apart here.
    //   - Refusal vs stale repost. After a host refusal with nothing newer
    //     buffered, the bytes stay on screen, held, and are not re-posted until
    //     the version advances or the user types / leaves the editor (I3). The
    //     host shows its own failure message; this side shows nothing.
    // The other two are local to this webview — nothing on the wire is missing,
    // the failure is observable right here — and are simply not handled:
    //   - The caret after `showHeld` is clamped like any reseed's, so after a
    //     readonly rewind + re-grant it can sit before the restored bytes.
    //   - A throwing `showHeld` leaves the view at the host's bytes with the
    //     buffer held; a keystroke typed there posts the view and replaces the
    //     buffer, with a console error as the only record.
    //
    // Doing this here — after applyDocument reseeded and the reducer committed —
    // is what lets the judgement read the settled world instead of predicting it.
    // An earlier draft judged the in-flight holder pre-reseed and carried a
    // boolean latch, which a throwing `view.dispatch` could strand into a false
    // notice on the NEXT, healthy ack.
    const newest = buffered ?? settledInFlight;
    // Held as the SUBJECT (null when nothing was lost) rather than as a boolean
    // beside it: the verdict and the holder the warn below has to name are then
    // one value, so the type carries "a loss always has a subject" instead of a
    // second null check re-asserting it.
    const lostSubject = newest !== null && lostToSupersession(newest) ? newest : null;
    // Captured BEFORE the drop so the notice arm below can tell whether this
    // branch already left a record for this drain — ONE warn per drain, for
    // whichever holder lost.
    const droppedBuffer =
      buffered !== null && shouldDropBufferedForEpoch(buffered) ? buffered : null;
    if (droppedBuffer !== null) {
      // The DROP is unconditional on content — replaying over foreign bytes is
      // the bug this rule exists to prevent, so a buffer whose lineage lost is
      // discarded whether or not the user lost anything by it. Only the NOTICE
      // below is conditional. Report HOW MUCH went, not just which lineage lost
      // it — the same contract warnReadonlyDrop argues for, applied to this
      // module's other content-discarding path. `droppedLength` IS the buffer,
      // and `liveLength` is what the user is left looking at; the two diverge
      // precisely when the foreign Document reseeded the view, which is the case
      // worth triaging.
      // Length only: buffered document bytes must never reach the console.
      console.warn("[quoll] dropping stale replay buffer (foreign epoch / identity transition)", {
        stampGeneration: droppedBuffer.generation,
        stampEpoch: droppedBuffer.epoch,
        recordedGeneration: recorded.generation,
        recordedEpoch: recorded.epoch,
        droppedLength: droppedBuffer.content.length,
        liveLength: opts.getDoc().length,
      });
      buffered = null;
    }
    if (lostSubject !== null) {
      if (droppedBuffer === null) {
        // The OTHER holder. A surviving buffer can never be the lost subject —
        // `lostToSupersession`'s first conjunct IS the drop predicate — so
        // reaching here means no buffer was held and the subject is the Edit the
        // ack just settled: posted, never acked, and the host's lineage has moved
        // past it without carrying the bytes. Same contract as the buffer drop
        // above, applied to this module's other content-discarding path, so a
        // support report of the user notice is triageable for BOTH holders rather
        // than one.
        // Length and lineage only: document bytes must never reach the console.
        console.warn(
          "[quoll] discarding an un-acked in-flight Edit (foreign epoch / identity transition)",
          {
            stampGeneration: lostSubject.generation,
            stampEpoch: lostSubject.epoch,
            recordedGeneration: recorded.generation,
            recordedEpoch: recorded.epoch,
            droppedLength: lostSubject.content.length,
            liveLength: opts.getDoc().length,
          }
        );
      }
      // USER-visible counterpart to the console records above (one per holder): a
      // webview devtools console is not a signal a normal user can see, and this
      // is a real content loss.
      // TWO INDEPENDENT properties hold here, each answering a different failure:
      //   - The POSITION (after the buffer is dropped, with the in-flight holder
      //     already cleared by the caller) answers RE-ENTRANCY. A notifier that
      //     synchronously re-enters the drain — the shell's dispatch wrapper can —
      //     is handed `settledInFlight = null` and finds no buffer, so it can
      //     neither re-announce nor re-judge the same loss.
      //   - The LOCAL CATCH answers EXCEPTION ESCAPE. The drain runs inside the
      //     shell's dispatch chain, whose contract is that a committed transition
      //     does not throw (shell.ts's dispatch doc). A failed NOTICE must not
      //     take the editor's sync loop down with it, so it degrades to a logged
      //     error.
      // Neither subsumes the other: with the catch alone a re-entrant notifier
      // still double-fires, and with the ordering alone a DOM exception still
      // escapes into the dispatch chain. Both are pinned in cm-edit-sync.test.ts
      // ("RE-ENTRANT notifier" / "THROWING notifier"), for BOTH holders.
      try {
        opts.onLocalEditDiscarded?.();
      } catch (err) {
        console.error("[quoll] onLocalEditDiscarded threw", err);
      }
    }
    if (buffered === null || !seeded || editInFlight || !canWrite) {
      return;
    }
    if (!canPost()) {
      return;
    }
    // Writable with a surviving buffer: the view must SHOW those bytes before
    // they are posted (I2) — a readonly Document may have rewound it, or the
    // buffer was demoted under a Document that reseeded.
    // INSIDE the `canPost()` gate. A drain that finds the gate closed is never
    // one where a host Document rewound the view: the reducer's `document` arm
    // always commits `serializeError: null`, so a Document's drain runs with
    // the gate open. With the gate closed the view can only be AHEAD of the
    // buffer — the case that matters is the drain a failing `post` re-enters
    // (`postEditMessage` dispatches `serialize-error` from inside the call),
    // which runs before trySend / flush have stamped the bytes being posted.
    // Showing the buffer there would rewind the view behind that keystroke, and
    // the next one would be typed without it.
    // BEFORE the dedupe: bytes I3 holds back from the wire must still be on
    // screen, or the next keystroke would be typed without them.
    // `timer === null`: a live timer means the view holds a keystroke not yet
    // captured, and this drain may not be a Document's (which cancels the timer
    // first) — overwriting the view would destroy it. The pending flush will
    // post the view as it stands.
    if (timer === null && !sameTextIgnoringEol(buffered.content, opts.getDoc())) {
      try {
        opts.showHeld?.(buffered.content);
      } catch (err) {
        // Not posted: the buffer stays for the next drain. Posting bytes the
        // screen failed to show would recreate the split this step prevents.
        // Lengths only: buffered document bytes must never reach the console.
        // `buffered?.`: the callback may have discarded the buffer before it
        // threw.
        console.error("[quoll] showHeld threw", err, {
          heldLength: buffered?.content.length ?? null,
          liveLength: opts.getDoc().length,
        });
        return;
      }
      // `showHeld` is caller code that dispatches on the view; it can re-enter
      // this module (`discardBuffer`, a drain, a snapshot). Re-read the state
      // the guard above established rather than trusting it.
      if (buffered === null || editInFlight || !canWrite) {
        return;
      }
    }
    const content = buffered.content;
    // I3: these exact bytes already went out at this base and the host's answer
    // did not carry them. Keep the buffer and wait — see `lastPost`.
    if (
      lastPost !== null &&
      lastPost.baseDocVersion === docVersion &&
      lastPost.content === content
    ) {
      return;
    }
    editInFlight = true;
    const ok = opts.post(content, docVersion);
    if (ok) {
      buffered = null;
      inFlight = stampHeld(content);
      notePost(content);
    } else {
      editInFlight = false;
      inFlight = null;
      // The post never left: keep the bytes for the next drain. `lastPost` is
      // untouched, so that retry is not mistaken for a repeat.
      buffered = stampHeld(content);
    }
  };

  return {
    onLocalChange: () => schedule(trySend),
    // Host snapshot metadata, plus the demotion. Updates the version + canWrite
    // edit-sync echoes on its next Edit. It does NOT clear editInFlight
    // and does NOT drain — those belong to onReducerCommit, driven by
    // the reducer's committed `state.editInFlight`. (Earlier drafts
    // cleared editInFlight here and/or replayed; both created the
    // divergences the doc comment on onHostSnapshot above details.)
    onHostSnapshot: (nextVersion, nextCanWrite, nextEpoch, nextGeneration, content) => {
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
          toGeneration: nextGeneration,
          fromEpoch: recorded.epoch,
          toEpoch: nextEpoch,
        });
        noteIdentityTransition();
      }
      if (nextCanWrite) {
        // Write is back: the readonly episode is over.
        readonlyHoldAnnounced = false;
        readonlyHoldTraced = false;
      }
      const incoming: DocumentIdentity = { epoch: nextEpoch, generation: nextGeneration };
      if (supersedesIdentity({ from: recorded, to: incoming })) {
        // The lineage moved: the answer the last post got says nothing about
        // how the new lineage would answer the same pair.
        lastPost = null;
      }
      if (nextCanWrite && !canWrite) {
        // Write re-granted: a post made before the readonly episode may have
        // been turned away by it, so bytes held across the flip must be free to
        // go out again at the same base.
        lastPost = null;
      }
      docVersion = nextVersion;
      canWrite = nextCanWrite;
      seeded = true;
      // Capture the identity pair alongside the version.
      recorded = incoming;
      // Demotion — see the onHostSnapshot JSDoc. AFTER the pair is adopted, so
      // the lineage test is against the Document just accepted. `buffered ===
      // null`: a held buffer is already the newest carrier (it descends from, or
      // equals, the in-flight bytes) and must not be replaced by older ones. The
      // demoted value keeps its ORIGINAL stamp, so a later foreign Document
      // still drops it.
      if (
        buffered === null &&
        inFlight !== null &&
        !supersedesIdentity({ from: inFlight, to: recorded }) &&
        !sameTextIgnoringEol(inFlight.content, content)
      ) {
        buffered = inFlight;
      }
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
      // The ack SETTLES the posted bytes: clear the holder here, paired with
      // `editInFlight` above so the "non-null exactly while in flight" invariant
      // lives in ONE function — and pass the settled value on as EVIDENCE. The
      // drain needs it to ask whether those bytes survived; destroying it first
      // (or letting the drain clear it) would either lose the evidence or make
      // the drain a mutator of this holder, which a future caller from a
      // gate-clear path could use to null a genuine in-flight Edit.
      const settledInFlight = inFlight;
      inFlight = null;
      replayIfNeeded(settledInFlight);
    },
    // Capture the latest doc into the buffer BEFORE clearing the timer.
    // onLocalChange always DEBOUNCES, so a keystroke typed inside the
    // 300 ms window has NOT yet reached `buffered`; if a host Document
    // arrives and applyDocument calls cancelPendingFlush() then reseeds,
    // that keystroke would be lost under the host snapshot. Snapshotting
    // getDoc() here (subject to the same readonly rule as trySend)
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
          // The in-window change is dropped by NOT capturing it; a buffer held
          // from before the readonly flip stays for a re-grant to replay.
          warnReadonlyDrop("cancelPendingFlush");
        } else {
          buffered = stampHeld(opts.getDoc());
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
      // external-edit clobber the accept path would cause). The serialize-error
      // gate keeps the buffer; a failed post keeps the buffer for the next ack.
      const hadTimer = timer !== null;
      clearTimer();
      // Readonly is decided BEFORE `content` is chosen, because the two things
      // that could be pending get opposite treatment: the in-window change is
      // dropped (mirrors trySend), a held buffer is kept and announced. Reading
      // `content` first would hand the buffer to the drop.
      if (!canWrite) {
        if (hadTimer) {
          warnReadonlyDrop("flush");
        }
        noteReadonlyHold();
        return;
      }
      const content = hadTimer ? opts.getDoc() : (buffered?.content ?? null);
      if (content === null) {
        return; // nothing pending — genuine no-op
      }
      if (!seeded || !canPost()) {
        // Gate closed: keep for a later drain. (`!seeded` is defensive — pre-seed
        // never passes the `!canWrite` return above.)
        buffered = stampHeld(content);
        return;
      }
      const wasInFlight = editInFlight;
      const ok = opts.post(content, docVersion);
      if (ok) {
        editInFlight = true; // maintain single-flight even on an alive hide→show
        inFlight = stampHeld(content);
        notePost(content);
        // Retain for ack-replay ONLY under in-flight contention (the sole path
        // to the stale settlement→ack window); otherwise the host accepted the
        // post and is the authority, so null it like trySend's idle post (JSDoc).
        buffered = wasInFlight ? stampHeld(content) : null;
      } else {
        buffered = stampHeld(content); // post failed: keep for the next ack
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
    // Ground the fold on the very holder whose survival it predicts: replay
    // drops `buffered` iff supersedesIdentity({from: buffered, to: recorded}),
    // so reading that stamp against the incoming pair makes display and replay
    // agree BY CONSTRUCTION once the pair is recorded. With no buffer held the
    // in-flight Edit is the newest holder, and its stamp is the one the demotion
    // and the drain's loss judgement will read for this same Document.
    viewHoldsUnackedEdit: (liveDoc, externalEpoch, epochGeneration) => {
      const newest = buffered ?? inFlight;
      return (
        newest !== null &&
        sameTextIgnoringEol(liveDoc, newest.content) &&
        !supersedesIdentity({
          from: newest,
          to: { epoch: externalEpoch, generation: epochGeneration },
        })
      );
    },
    recordedIdentity,
    isIdentityTransition,
  };
}
