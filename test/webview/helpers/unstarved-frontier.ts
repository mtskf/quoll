import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
// `UnstarvedCaller` is imported rather than declared here so membership stays ONE fact:
// ./parse-to-end.ts sums the settling and non-settling halves into the union
// `assertHasLanguage` accepts, and this module IS the non-settling half. Its declaration
// carries the measurement showing a local copy would red rather than drift silently — read
// it there rather than restating it, since a rationale written out at both ends of one
// import is itself the two-places-kept-equal shape the export exists to avoid.
//
// Most refusals below interpolate it so the message names its caller; the refusals raised
// inside a form's `postCheck` or `admitGate` spell their prefix out instead, because `caller`
// is a sibling property of the same object literal and so is not in scope inside either, and
// the sentinel names no caller at all (see its constructor).
import { assertHasLanguage, type UnstarvedCaller } from "./parse-to-end.js";

/**
 * Sentinel for "this attempt's parse frontier was starved, so there was nothing to
 * observe". Private on purpose: only the `requireUnstarvedFrontier` handed to `observe`
 * constructs it, so the `catch` that abandons an attempt can never swallow a real
 * failure. An `Error` subclass rather than a thrown literal so Biome's throw rules stay
 * satisfied, and so an accidental escape surfaces with a stack.
 */
class StarvedFrontier extends Error {
  // `name` and a body are not decoration. An Error subclass inherits the name "Error" and
  // a zero-argument construction leaves `message` empty, so without these an escaped
  // sentinel is reported as a bare `Error:` with nothing in it — half of what the docblock
  // above promises a reader will see.
  readonly name = "StarvedFrontier";
  constructor() {
    super(
      // No caller prefix — a deliberate choice, not an impossibility: the constructing
      // gate does know its caller (it hands `caller` to assertHasLanguage a few lines up).
      // This message is read on TWO paths, and a prefix would help on neither: as the
      // `cause` of the swallow refusal it already hangs off a caller-prefixed wrapper (both
      // forms pin that shape in ./unstarved-frontier.test.ts), and on an escape from a
      // listener or timer the mistake is the same in both forms. So the message describes
      // the SIGNAL and both mistakes that surface it, rather than asserting how it got
      // here, and stays caller-neutral rather than threading a parameter through a class
      // whose message never varies.
      "starved-frontier signal from requireUnstarvedFrontier() — it does not return when the frontier is starved, so it must be called synchronously from the observe() body (never from a listener, timer, or deferred callback) and must never be caught"
    );
  }
}

/**
 * Marks a refusal raised by THIS HELPER, so the catch-side swallow check wraps only errors
 * that came out of `observe`. Without it the catch relabels the helper's own diagnoses: an
 * async `observe` that gated before its first `await` leaves `sentinelsThrown` at 1, so the
 * "must be synchronous" message — deliberately checked first so the reader is sent to the
 * right bug — is replaced by the swallow advice, and the return-path swallow refusal is
 * wrapped in a second copy of itself.
 *
 * Siblings with `StarvedFrontier`, never related to it in either direction. If this class
 * were a PARENT of the sentinel, an escaping sentinel would MATCH `error instanceof
 * HelperRefusal`, so the `!(…)` guard below would evaluate FALSE, the `&&` would
 * short-circuit, and the swallow-count detection would stop firing on the escape path — the
 * "swallowed one sentinel and let a later one escape" case would be retried away
 * undetected. (The `!(error instanceof StarvedFrontier)` rethrow under it is
 * unaffected by that direction: `instanceof` walks the prototype chain, so the sentinel is
 * still absorbed.) If the sentinel were a parent of THIS, that rethrow WOULD be the
 * casualty — it would absorb the helper's own refusals and retry them.
 */
class HelperRefusal extends Error {}

/**
 * What the form hands the observation, as the ungated refusal names it. The view form
 * measures a VIEW; the state form measures a STATE, and a refusal that told a
 * fenced-code author their "view" was ungated would be pointing at something that does
 * not exist in that test.
 */
const SUBJECT: Record<UnstarvedCaller, string> = {
  withUnstarvedFrontier: "view",
  withUnstarvedFrontierState: "state",
};

/**
 * Shared by the two swallow detections below — the return path cannot see a swallow that
 * is followed by a throw, and the catch path cannot see one that is followed by a return,
 * so both need to say the same thing.
 */
const swallowedSentinelMessage = (caller: UnstarvedCaller): string =>
  `${caller}: observe() swallowed the starved-frontier signal — do not wrap requireUnstarvedFrontier() in your own catch, and do not run it inside expect(...).toThrow()`;

/**
 * The same, for a swallowed gate refusal, detected by the conservation law documented at the
 * counter declarations in runUnstarvedAttempts. Shared by the return and sentinel-escape
 * paths.
 */
const swallowedRefusalMessage = (caller: UnstarvedCaller): string =>
  `${caller}: requireUnstarvedFrontier() was called but its refusal was swallowed — do not wrap it in your own catch, and do not run it inside expect(...).toThrow(); re-run without the catch to see the underlying error`;

/**
 * The attempt loop and every refusal both public forms share. Private: the forms differ in
 * what they own (a mounted view, or nothing), in what their final "is what you measured
 * what you gated" check COMPARES (`view.state` vs the state `observe` returned — different
 * operands, not different prose for one), and in the gate arity each exposes to its caller
 * (`() => void` vs `(state: EditorState) => void`); the view form additionally probes for a
 * language once per attempt, before `observe` runs, where the state form has no seam for
 * one. All of that is expressed as parameters here so the control flow — the per-attempt
 * abandon and the trailing all-starved throw — exists once.
 *
 * `R` is deliberately UNCONSTRAINED here. Each public form constrains its own `observe`
 * return type, and they constrain it to opposite things: the view form to `void |
 * undefined` (nothing to return), the state form to `EditorState` (the state it
 * measured). A constraint here could only be the union of those, which would refuse
 * neither mistake.
 */
function runUnstarvedAttempts<C, R>(spec: {
  caller: UnstarvedCaller;
  what: string;
  attempts: number;
  /**
   * Build the per-attempt fixture, and return it alongside the teardown it owes. Called
   * once per ATTEMPT. A `teardown` here may simply throw: the core's `finally` owns "a
   * teardown failure must not REPLACE a failure already in flight" for every form at once,
   * so no form needs to know whether one is propagating — and it is not handed the flag,
   * because a parameter no implementation reads is one nothing reds on when the core passes
   * it wrongly. (If a form ever needs to tear down DIFFERENTLY under a propagating failure,
   * hand it the flag then, and pin the difference.)
   * A `begin` that THROWS owes the disposal of whatever it had already constructed: no
   * teardown ever reached this loop.
   */
  begin: () => { context: C; teardown: () => void };
  /** The measurement. Receives the gate, which must be handed the state it speaks for. */
  observe: (context: C, gate: (state: EditorState) => void) => R;
  /**
   * The "what you handed back is what you gated" check, in the outer form's own terms. Run
   * after this loop's own refusals — so an async or ungated `observe` is reported as such
   * rather than as a mismatch — and before teardown, so it can still read the fixture.
   */
  postCheck: (context: C, stateAtLastGate: EditorState, returned: R) => void;
  /**
   * Run on every gate ENTRY, after `assertHasLanguage` and BEFORE the starvation check, so a
   * refusal raised here is never retried as starvation and, if `observe` swallows it, is
   * convicted by the conservation law below. Throw a plain Error (as assertHasLanguage does —
   * never HelperRefusal, which would skip the catch arm's swallowed-sentinel wrap and hide an
   * earlier swallow behind this refusal) or return.
   */
  admitGate: (context: C) => void;
}): void {
  const { caller, what, attempts, begin, observe, postCheck, admitGate } = spec;
  // Refused for two DIFFERENT reasons, both about the all-starved throw below telling the
  // truth. A non-positive count skips the loop entirely and falls straight through to that
  // throw, whose message would then claim a starved frontier was FOUND on attempts that
  // never ran. A fractional count does the opposite — `a < 2.5` runs THREE times — so the
  // message would under-report the attempts it made. Integer-and-positive is the only shape
  // for which `attempts` names what was measured.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`${caller}: attempts must be a positive integer, got ${attempts}`);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { context, teardown } = begin();
    // The state as of the LAST gate call. NOT a record of whether the gate ever fired: the
    // gate's `assertHasLanguage` and `admitGate` run FIRST and can throw before this is ever
    // assigned, which is what `gateCalls` and `gatesCompleted` below exist to see.
    let stateAtLastGate: EditorState | undefined;
    // COUNTED, not a boolean. At most ONE sentinel can escape an attempt, so a count above
    // what escaped proves an earlier one was swallowed — which the return-path check alone
    // cannot see when observe() swallows and then throws.
    let sentinelsThrown = 0;
    // Gate ENTRY and gate COMPLETION, so the three counts here obey one conservation law:
    // every gate that is ENTERED leaves by exactly one of four routes — it completes, it
    // throws the sentinel, `assertHasLanguage` refuses it, or the form's `admitGate` refuses
    // it (what each may throw: the `admitGate` member docblock above). Only the last two
    // leave no record of their own, so gate ENTRIES in EXCESS of the other two counts ARE
    // refusals that observe() caught. (Only that direction is reachable: `gateCalls++` is the
    // gate's first statement, so `gateCalls >= gatesCompleted + sentinelsThrown` always
    // holds.) Without it a swallowed gate refusal falls through to the ungated branch and
    // is reported as "you never gated" (false, and points at the wrong bug), and one
    // FOLLOWED BY a successful gate leaves no trace at all — where the equivalent swallowed
    // sentinel is always refused.
    // All three reset per ATTEMPT: a count carried over from an abandoned attempt would
    // convict the attempt after it.
    let gateCalls = 0;
    let gatesCompleted = 0;
    let propagating = false;
    try {
      const returned = observe(context, (state) => {
        gateCalls++;
        // Here rather than only once per attempt, because the state form has no earlier
        // seam: it holds no state until `observe` makes one. `syntaxTreeAvailable` is ALSO
        // false with no Language attached, so without this a misconfigured extension list
        // masquerades as N starved attempts and is then reported as CPU starvation. The
        // throw is a plain Error, so the catch below rethrows it rather than retrying.
        // (The view form ALSO checks before `observe` runs — see its `observe` adapter.)
        //
        // ⚠️ Running it per GATE CALL, where the old code ran it once per ATTEMPT, is a
        // CLASSIFICATION change and not merely a frequency one. If a language extension
        // goes away MID-attempt (a `Compartment` reconfigured to `[]` between two gates),
        // the old code had already done its only check and the second gate saw a false
        // `syntaxTreeAvailable`, so the attempt was abandoned as starved and the run ended
        // blaming the CPU. This refuses it immediately, with a message that names the
        // actual cause, and does not retry. Pinned by "names a language lost MID-attempt
        // instead of retrying it as starvation" in ./unstarved-frontier.test.ts — narrow
        // this to the first gate call of an attempt and that test reds.
        assertHasLanguage(state, caller);
        admitGate(context);
        stateAtLastGate = state;
        if (!syntaxTreeAvailable(state, state.doc.length)) {
          sentinelsThrown++;
          throw new StarvedFrontier();
        }
        gatesCompleted++;
      });
      // An async `observe` would silently break every guarantee here: the loop reaches this
      // line at the callback's first `await`, tears the fixture down out from under the
      // rest of it, and reports success. Checked BEFORE the counter checks below: an async
      // callback suspended before its gate is also ungated, and reporting it as ungated
      // would send the reader to the wrong bug.
      if (typeof (returned as { then?: unknown } | undefined)?.then === "function") {
        // Detach the abandoned continuation before throwing: it resumes on a later
        // microtask, and an assertion failure there would surface as an unhandled rejection
        // during an unrelated, later test. `Promise.resolve(...)` rather than
        // `returned.catch(...)` — the condition above admits ANY thenable, and a thenable
        // need only have `.then`.
        void Promise.resolve(returned).catch(() => {});
        // HelperRefusal, here and on the checks below: the catch's swallow detection must
        // wrap only what came out of `observe`, never a refusal raised here — which would
        // relabel this loop's own diagnosis.
        throw new HelperRefusal(
          `${caller}: observe() must be synchronous — an async callback is abandoned mid-flight and its assertions never gate the result`
        );
      }
      if (sentinelsThrown > 0) {
        throw new HelperRefusal(swallowedSentinelMessage(caller));
      }
      // Apply the conservation law documented at the counter declarations. Reaching this
      // check means observe() returned; any unaccounted gate entry therefore represents a
      // swallowed refusal.
      if (gateCalls > gatesCompleted + sentinelsThrown) {
        throw new HelperRefusal(swallowedRefusalMessage(caller));
      }
      // Reached only when every gate entry is accounted for, so this is now exactly "no
      // gate was ever entered" rather than "nothing recorded one".
      if (stateAtLastGate === undefined) {
        throw new HelperRefusal(
          `${caller}: observe() returned without calling requireUnstarvedFrontier(), so ${what} was measured on an ungated ${SUBJECT[caller]}`
        );
      }
      postCheck(context, stateAtLastGate, returned);
      return;
    } catch (error) {
      propagating = true;
      if (
        !(error instanceof HelperRefusal) &&
        sentinelsThrown > (error instanceof StarvedFrontier ? 1 : 0)
      ) {
        throw new Error(swallowedSentinelMessage(caller), { cause: error });
      }
      if (!(error instanceof StarvedFrontier)) {
        throw error;
      }
      // The same conservation law as the return path, on the one escape flavour that can
      // decide it. Past the rethrow above the escaping error IS the sentinel, and the
      // sentinel already paid for itself with its own `sentinelsThrown++` — so a residual
      // excess here is provably a refusal `observe` caught earlier in THIS attempt, and is
      // refused rather than absorbed. Retried instead, the swallow would either be reported
      // as CPU starvation (every attempt starves) or erased outright by a later clean
      // attempt (a swallow that does not recur — `observe` re-runs FROM THE TOP, so an
      // attempt-order-dependent body is not hypothetical).
      //
      // A plain `Error` escape gets no such check and is rethrown above: there an excess of
      // ONE is undecidable, because the escaping error may itself BE the unrecorded refusal.
      // (Two or more would still convict — one error accounts for at most one refusal — but
      // the rethrow above is deliberately unconditional rather than delaying a real failure
      // to second-guess a count.) `instanceof` is what separates the two, and it has already
      // run.
      if (gateCalls > gatesCompleted + sentinelsThrown) {
        throw new HelperRefusal(swallowedRefusalMessage(caller));
      }
      // The sentinel is absorbed: the attempt is retried, nothing is in flight any more, so
      // a teardown failure below IS the failure and must propagate.
      propagating = false;
    } finally {
      // The core owns "a teardown failure must not REPLACE a failure already in flight":
      // a throwing `finally` discards the pending exception outright rather than chaining
      // it. Keeping the guard HERE rather than in each `begin` is what stops a third form
      // from re-introducing the hazard — the lint rule that used to catch it
      // (noUnsafeFinally) stopped applying the moment the teardown moved behind a call,
      // so the property would otherwise rest on each form remembering the convention.
      try {
        teardown();
      } catch (teardownError) {
        if (!propagating) {
          // Nothing is in flight, so this failure IS the failure — and it must not be
          // written off as "beside a primary one" that does not exist. Re-throwing out of
          // a `finally` discards the pending completion, which here is either a successful
          // `return` or an absorbed sentinel; both are things a teardown defect should
          // override.
          // biome-ignore lint/correctness/noUnsafeFinally: guarded — nothing is in flight here
          throw teardownError;
        }
        console.error(
          `${caller}: teardown ALSO threw; the failure being reported is the primary one`,
          teardownError
        );
      }
    }
  }
  throw new Error(
    `${caller}: all ${attempts} attempts found a starved parse frontier, so ${what} was never observed`
  );
}

/**
 * The view form's per-attempt context: the mounted view, plus the doc-change count and
 * state-continuity record its update wrapper keeps between gates (see the wrapper comment in
 * `begin`).
 */
type ViewAttempt = {
  view: EditorView;
  docChanges: number;
  expectedUpdate: { readonly state: EditorState };
  bypassObserved: boolean;
  activeUpdates: number;
};

/**
 * Run a single bounded-path observation against a freshly mounted view, retrying from a
 * FRESH view whenever the parse frontier came back starved, and THROWING if every attempt
 * was starved.
 *
 * Why this exists at all. Several tests observe a CodeMirror field's bounded (reuse) path
 * by dispatching one small edit on a fully-parsed view and then reading the field BEFORE
 * anything settles — the whole point being that a self-heal must not mask a bounded bug.
 * That observation is only meaningful when the post-edit parse frontier is COMPLETE,
 * because `syntaxTreeAvailable` is the very predicate those fields consult to choose
 * between the bounded recompute and the full walk. Every one of them also carries a
 * STRUCTURAL check — some OR it into that same condition, some reach the frontier check
 * only after a separate, earlier structural arm has declined — but no form of that check
 * can be STARVED, so it is not what this gate speaks for. What the gate speaks for is the
 * frontier: it is the one input to the choice that a loaded machine can change underneath
 * the test.
 *
 * Asserting that gate on a SINGLE attempt is what makes those tests load-fragile.
 * CodeMirror gives its post-edit reparse a 20ms WALL-CLOCK budget; under CPU starvation
 * that window can elapse while this process is descheduled, before any real parse work
 * happens. The field then legitimately takes its G2 fallback and full-walks the
 * currently-available tree DURING the dispatch, the bounded path is not what ran, and a
 * bare `expect(...).toBe(true)` reds on a fact about the machine rather than about the
 * code under test. (The later background-parse "self-heal" is a DIFFERENT branch and never
 * fires here — nothing settles after the edit, which is the whole point.) Measured on a
 * deliberately loaded full-suite run (24 spinners on 8 cores) while PR #388 was in flight.
 *
 * ⚠️ This is NOT a retry that hides a regression, and it is NOT a silent skip either:
 *   - a genuine break in the bounded path reds EVERY attempt that gets far enough to
 *     look, because only a starved frontier is caught here — an assertion failure
 *     propagates out of the first attempt that raises it;
 *   - if every attempt is starved, nothing was measured and this THROWS, so the test can
 *     never pass by having quietly observed nothing.
 * A vitest-level `{ retry: n }` has neither property. The global `test.retry` knob is
 * refused in `vitest.config.ts` for exactly that reason (it masks real regressions); the
 * per-suite option is the same trade with a narrower blast radius and nothing mechanical
 * stops it, which is why the loop is written out here instead.
 *
 * Why it is a shared helper rather than a per-file loop. Both properties above live in
 * control flow — the per-attempt abandon (the `catch` that absorbs the sentinel and lets
 * the `for` iterate) and the trailing all-starved `throw` — and control flow is exactly
 * what a copied loop loses first: ./settled-view.ts documents how this suite's per-file
 * `forceParse` wrappers mostly dropped the same boolean check. Putting the loop where an
 * author using it cannot omit the all-starved throw is the same answer to the same
 * problem. What stays at the call site is the site-specific part: what to mount, what to
 * dispatch, where the frontier must be complete, and what to assert.
 *
 * SCOPE: this module owns BOTH forms of the loop, and every instance of it in the suite
 * now routes through one of them. `withUnstarvedFrontier` is for a mounted view;
 * `withUnstarvedFrontierState` is for a bare `EditorState` driven through
 * `state.update()`, which has no view to mount or destroy. They share
 * `runUnstarvedAttempts` for the reason above.
 *
 * Both forms make the same final claim — what you HAND BACK at the end is what you last
 * gated — and reach it differently, because they own different things. The view form owns
 * the view, so it reads `view.state` after `observe` returns. The state form owns nothing
 * and never sees the caller's local variable, so it REQUIRES `observe` to return the state
 * its assertions read and compares that.
 *
 * ⚠️ One gap that claim deliberately leaves open, in BOTH forms: an `observe` that derives a
 * THIRD state and asserts on that one passes, because what is compared is the state the
 * form can see at the end — `view.state` in the view form, the returned state in the state
 * form — which is the most either can know from outside the callback. Intermediate-update
 * coverage differs between the forms and is partial even in the view form (doc-changing
 * transactions only); each form's observe contract states what it refuses.
 *
 * ⚠️ Do NOT wrap `requireUnstarvedFrontier()` in a `try`/`catch` of your own, and do not
 * run it inside `expect(...).toThrow(...)`. Either swallows the sentinel, and a swallowed
 * sentinel is exactly the silent skip this helper exists to prevent. This is not left as
 * etiquette: the gate records that it fired, and a swallowed signal is refused below.
 *
 * OWNERSHIP (the VIEW form only — the state form constructs nothing and an `EditorState`
 * needs no disposal): that form constructs the parent element and calls `mount`, so it both
 * owes a teardown and discharges it on every path — success, starvation, and a propagating
 * failure alike. `mount` must build its view on the `parent` it is handed and must NOT
 * dispose of it; ownership transfers to this helper the moment `mount` returns. A `mount`
 * that THROWS still owes the disposal of whatever it had already constructed, because no
 * reference ever reached here. Consistent with `settledMount`'s rule in ./settled-view.ts:
 * whoever constructs owes the destroy.
 *
 * ⚠️ Build the view with `settledMount()`, not `new EditorView(...)` followed by a
 * separate `settledView(...)`. The two-statement form can throw AFTER constructing the
 * view but BEFORE returning it, and a view this helper never received is one it cannot
 * destroy — it leaks with its timers and its happy-dom document attached.
 * `settledMount()` disposes of what it built on that path, which closes the window.
 *
 * `mount` failing is NOT a starved frontier and is NOT retried — a view that will not
 * settle is a real failure, and retrying it four more times would only bury the message.
 */
// `R` is a constrained TYPE PARAMETER rather than a literal `void`: TypeScript ignores a
// callback's return type only when the target return type is EXACTLY `void`, so an async
// `observe` is assignable to a `=> void` parameter with no cast at all. The union is what
// makes it a compile error instead — a bare `R extends void` falls back to the constraint
// and admits the async form again. The runtime thenable probe in the core stays as the
// backstop for a fixture cast through a wider type.
//
// Biome's suggested rewrite to a bare `undefined` is NOT equivalent: it would reject the
// shapes written at the call sites (a block body, and the concise void expression
// `(_v, gate) => gate()`), both of which infer `void` — as would a bare `return;`, which
// nothing writes today but which is the natural third.
// biome-ignore lint/suspicious/noConfusingVoidType: the union is what refuses an async observe
export function withUnstarvedFrontier<R extends void | undefined>(options: {
  /** What the observation is, phrased to complete "…was never observed". */
  what: string;
  /**
   * Build a mounted, settled view on the supplied parent. Use `settledMount()`. Called
   * once per ATTEMPT, so it must be able to build the fixture from scratch each time.
   */
  mount: (parent: HTMLElement) => EditorView;
  /**
   * The measurement. Call `requireUnstarvedFrontier()` at every point where the parse
   * frontier must be complete for what follows to mean anything; it does not return when
   * the frontier is starved, abandoning the attempt instead.
   *
   * ⚠️ Re-run FROM THE TOP on every retry, so it must be free of side effects visible
   * outside itself — a counter incremented or an array pushed from here is multiplied by
   * however many attempts a loaded machine starves, i.e. non-deterministically and only
   * under load. Derive everything the assertions need INSIDE this callback, from the
   * `view` it is handed.
   *
   * ⚠️ Call the gate after each doc-changing transaction: `dispatch A; dispatch B; gate()`
   * leaves A's bounded run unwitnessed, and a starved A self-heals with a full walk, so an
   * oracle comparison goes green having exercised nothing. The view form REFUSES more than
   * one doc-changing transaction between two gates (or between mount and the first gate),
   * judged in its `admitGate`. Selection- and effect-only transactions do not count, which
   * is the shape cm-block-widget-bounded.test.ts's `cursorAtEnd` rows rely on; it also
   * means an effect-only reconfiguration between a change and its gate passes uncounted, so
   * gate before reconfiguring. See the update-wrapper comment in `begin` for the scope of
   * state-continuity checks. A successful gate speaks only for the frontier at that
   * instant.
   */
  observe: (view: EditorView, requireUnstarvedFrontier: () => void) => R;
  /** Attempts before giving up and throwing. Five, matching PR #388's measured loop. */
  attempts?: number;
}): void {
  const { what, mount, observe, attempts = 5 } = options;
  runUnstarvedAttempts<ViewAttempt, R>({
    caller: "withUnstarvedFrontier",
    what,
    attempts,
    begin: () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);
      let view: EditorView;
      try {
        view = mount(parent);
      } catch (error) {
        // `mount` owes the disposal of anything it constructed — no reference reached
        // here. What THIS function owes, and discharges, is the parent it appended.
        parent.remove();
        throw error;
      }
      const teardown = (): void => {
        // Two statements in sequence are NOT "discharged on every path": a throwing
        // view.destroy() (CM does NOT guard widget destroy — WidgetView.destroy calls
        // widget.destroy(dom) bare, and this suite mounts table + fenced-code widgets
        // that implement it) would skip parent.remove(), leaving the view attached to
        // the shared happy-dom body for the rest of the file. The `finally` is what keeps
        // the parent removal unconditional, and it must stay nested INSIDE this teardown:
        // the core catches what escapes here, so hoisting the removal out would let the
        // core's catch take the destroy failure before the parent was ever removed.
        //
        // The destroy failure itself is let out bare. Whether it may replace a failure
        // already in flight is not this form's decision — the core's `finally` owns that
        // for every form, which is why this form does not decide it.
        try {
          view.destroy();
        } finally {
          parent.remove();
        }
      };
      const ctx: ViewAttempt = {
        view,
        docChanges: 0,
        expectedUpdate: { state: view.state },
        bypassObserved: false,
        activeUpdates: 0,
      };
      try {
        // The counting seam: an instance override of `view.update`. Per @codemirror/view's
        // own contract `update` is the primitive every dispatch reaches — "You should
        // usually call dispatch instead, which uses this as a primitive" — and a custom
        // `dispatchTransactions` "should probably call" it. Wrapping `dispatch` instead
        // would mean re-deriving the transaction list CM builds, which `update` is already
        // handed; an `updateListener` via `StateEffect.appendConfig` would itself be a
        // reconfiguring transaction on the measured view before `observe` ran.
        //
        // - The record is the TRANSACTION, never its lazy `.state` getter: reading that
        //   before CM validates the start-state chain would run the StateField updaters of a
        //   transaction CM is about to reject. By the time anything compares against
        //   `expectedUpdate.state`, CM has applied that transaction (or the catch below has
        //   restored the previous record).
        // - Recorded BEFORE `original` runs: CM runs `updateListener`s after releasing its
        //   update lock, so a listener's dispatch re-enters this wrapper while `original` is
        //   still on the stack and must find the expectation set here. Nothing overwrites the
        //   record with `view.state` after return, so a listener's `setState()` mismatches at
        //   the next entry or gate.
        // - The doc-changing count is SNAPSHOT before `original` (a callback may mutate the
        //   caller-owned array mid-update; `docChanged` does not touch the lazy state) and
        //   COMMITTED only after it returns. CM validates every start state before mutating
        //   anything, so a rejected update counts nothing. The catch restores only the
        //   record and never counts: an update that throws after advancing the state leaves
        //   `view.state` ≠ the restored record, so the next entry or gate sees a
        //   discontinuity and refuses it — where a try/finally count would let that doc
        //   change pass uncounted.
        // - CM's own `update([])` calls (observer / measure paths) count 0, as do
        //   selection-only and effect-only transactions — a Compartment reconfiguration
        //   included, which DOES move the frontier (see the view form's `observe` contract).
        // - Bypass scope: `view.state` is compared with the state the last wrapped update was
        //   asked to produce, at wrapped-update ENTRY and at gate entry (`admitGate`). That is
        //   not an audit of every intermediate replacement: replacing and then restoring the
        //   same state between two observations is outside this guarantee.
        // - Fails closed on a broken seam: a state that reached the view without passing
        //   here — `setState()`, a `dispatchTransactions` that bypasses `update`, or a future
        //   @codemirror/view whose default dispatch no longer reads `update` off the instance
        //   — is refused as a bypass rather than silently emptying the count.
        const original = view.update;
        view.update = (trs) => {
          ctx.bypassObserved ||= view.state !== ctx.expectedUpdate.state;
          const docChanges = trs.reduce((count, tr) => count + Number(tr.docChanged), 0);
          const previous = ctx.expectedUpdate;
          ctx.expectedUpdate = trs.length ? trs[trs.length - 1] : { state: view.state };
          ctx.activeUpdates++;
          try {
            original.call(view, trs);
          } catch (error) {
            ctx.expectedUpdate = previous;
            throw error;
          } finally {
            ctx.activeUpdates--;
          }
          ctx.docChanges += docChanges;
        };
      } catch (setupError) {
        // From here the helper owns the view, so it owes the teardown even though no
        // fixture was handed to the core. A teardown failure is reported beside the setup
        // error, never over it.
        try {
          teardown();
        } catch (teardownError) {
          console.error("withUnstarvedFrontier: teardown ALSO threw", teardownError);
        }
        throw setupError;
      }
      return { context: ctx, teardown };
    },
    observe: ({ view }, gate) => {
      // Once per attempt, BEFORE observe runs, and deliberately in addition to the gate's
      // own copy — which is what actually keeps a missing language from being reported as
      // CPU starvation (it throws a plain Error, so the core's catch rethrows rather than
      // retrying, whether or not this line exists). What THIS one adds is ORDERING: a
      // language-less view must fail as "no language configured" rather than letting
      // `observe` run up to its first gate and surface whatever it fails on first.
      assertHasLanguage(view.state, "withUnstarvedFrontier");
      return observe(view, () => gate(view.state));
    },
    postCheck: ({ view }, stateAtLastGate) => {
      // A gate speaks only for the frontier that existed when it ran, so a state replaced
      // AFTER the last one leaves what was actually measured ungated — on a starved
      // frontier that is a full walk compared against a full walk, i.e. the vacuous green
      // this helper exists to refuse.
      //
      // Compared by IDENTITY, not read off the counter and latch begin installs: those are
      // consumed at a GATE, and nothing that moves the view after the LAST gate ever
      // reaches one, so this comparison is the only check that sees that window. Reads
      // (view.state.field(...), a separate settledState(...) oracle) leave the identity
      // alone and pass. The message says "replaced its state" rather than "dispatched"
      // because that is what this observes: `EditorView.setState()` replaces the state
      // without dispatching.
      if (view.state !== stateAtLastGate) {
        throw new HelperRefusal(
          `withUnstarvedFrontier: observe() replaced its state after the last requireUnstarvedFrontier() call, so ${what} was measured on an ungated frontier`
        );
      }
    },
    admitGate: (ctx) => {
      // CONSUMES before it judges, so a gate called after a swallowed refusal runs clean
      // and the conservation law — not a second copy of this refusal — convicts the
      // swallow. Judged here rather than inside the update wrapper: a throw there surfaces
      // inside `view.dispatch(...)`, where an observe-side try/catch can swallow it with no
      // gate entry for the conservation law to convict; the gate is the one place a refusal
      // is both decidable and swallow-proof. When the core calls this and what it may throw:
      // the core's `admitGate` member docblock.
      if (ctx.activeUpdates > 0) {
        throw new Error(
          "withUnstarvedFrontier: requireUnstarvedFrontier() was called from inside view.update() (an updateListener or plugin), before the doc changes that triggered it were counted — gate from observe() after dispatch returns"
        );
      }
      const docChanges = ctx.docChanges;
      const bypassed = ctx.bypassObserved || ctx.view.state !== ctx.expectedUpdate.state;
      ctx.docChanges = 0;
      ctx.bypassObserved = false;
      ctx.expectedUpdate = { state: ctx.view.state };
      if (bypassed) {
        throw new Error(
          "withUnstarvedFrontier: the view's state changed since mount or the previous requireUnstarvedFrontier() call without passing through (or completing) view.update(), so the transactions that moved it were not all counted — apply transactions through view.update(), including from custom dispatch handlers; do not call setState() during observe(); if every call site fails this way after a @codemirror/view upgrade, dispatch no longer routes through update — see the wrapper comment in begin"
        );
      }
      if (docChanges > 1) {
        throw new Error(
          `withUnstarvedFrontier: ${docChanges} doc-changing transactions reached the view since mount or the previous requireUnstarvedFrontier() call, so all but the last ran unwitnessed — apply one doc-changing transaction per gate: gate between dispatches, split a multi-transaction dispatch, and keep listener-driven follow-ups out of the fixture`
        );
      }
    },
  });
}

/**
 * The view-free twin of `withUnstarvedFrontier()`: run one bounded-path observation against
 * bare `EditorState`s the callback builds itself, retrying from scratch whenever the parse
 * frontier came back starved, and THROWING if every attempt was starved.
 *
 * Why it exists, why an attempt loop rather than a vitest `{ retry: n }`, and the gap both
 * forms leave open are documented in full on `withUnstarvedFrontier` above — this form
 * shares its attempt loop (`runUnstarvedAttempts`) and every refusal in it. What differs:
 * this form owns nothing (an `EditorState` needs no disposal, so there is no `mount` and no
 * teardown) and it reaches the "what you handed back is what you gated" claim by REQUIRING
 * `observe` to return the state its assertions read.
 */
export function withUnstarvedFrontierState(options: {
  /** What the observation is, phrased to complete "…was never observed". */
  what: string;
  /**
   * The measurement. Call `requireUnstarvedFrontier(state)` at every point where that
   * state's parse frontier must be complete for what follows to mean anything; it does not
   * return when the frontier is starved, abandoning the attempt instead.
   *
   * ⚠️ RETURN THE STATE YOUR ASSERTIONS READ. It is compared against the state the LAST
   * gate saw, and a mismatch is refused. That is this form's counterpart to the view
   * form's post-gate check, and it is not paperwork: `gate(s); s = s.update(…);
   * expect(s…)` satisfies every other refusal here while asserting on a frontier nothing
   * ever gated — which on a starved run is a full walk compared against a full walk.
   * The return type is also what refuses an async callback at compile time.
   *
   * ⚠️ What that check actually proves is "the state you HANDED BACK is the one you last
   * gated" — not "your assertions read a gated state". Deriving a third state, asserting
   * on it, and returning the gated one passes. The wider claim is unprovable from here
   * (and equally unprovable in the view form, which compares `view.state`), so do not read
   * a green run as more than it is: the shape this closes is the one both call sites are
   * one edit away from, gate → update → assert.
   *
   * ⚠️ Re-run FROM THE TOP on every retry, so it must be free of side effects visible
   * outside itself — a counter incremented or an array pushed from here is multiplied by
   * however many attempts a loaded machine starves, i.e. non-deterministically and only
   * under load. Build the states this needs INSIDE the callback, as the fenced-code sites
   * do by calling `stateWithField()` per attempt.
   *
   * ⚠️ A gate speaks ONLY for the state it is handed. Gating early and updating twice more
   * before the final gate leaves the intermediate states unverified; the returned-state
   * check catches the LAST such gap, not every one. Gate after every update whose frontier
   * the assertions depend on. Unlike the view form, this is not refused here: the form holds
   * no view and the caller builds its states with `state.update(...)`, so no transaction
   * passes through a seam this form owns.
   */
  observe: (requireUnstarvedFrontier: (state: EditorState) => void) => EditorState;
  /** Attempts before giving up and throwing. Five, matching PR #388's measured loop. */
  attempts?: number;
}): void {
  const { what, observe, attempts = 5 } = options;
  runUnstarvedAttempts<undefined, EditorState>({
    caller: "withUnstarvedFrontierState",
    what,
    attempts,
    // This form owns nothing: the caller builds and rebuilds its own states inside
    // `observe`, and an EditorState needs no disposal. The no-op is written out rather
    // than made optional in the core so "who owes the teardown" stays a question every
    // form answers.
    begin: () => ({ context: undefined, teardown: () => {} }),
    // No view-owned update seam; see this form's observe contract.
    admitGate: () => {},
    observe: (_context, gate) => observe(gate),
    postCheck: (_context, stateAtLastGate, returned) => {
      if (returned !== stateAtLastGate) {
        throw new HelperRefusal(
          `withUnstarvedFrontierState: observe() returned a state other than the one requireUnstarvedFrontier() last saw, so ${what} was measured on an ungated frontier`
        );
      }
    },
  });
}
