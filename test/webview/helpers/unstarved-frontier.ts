import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { assertHasLanguage } from "./parse-to-end.js";

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
      // No caller prefix: this one class is thrown by both public forms, and it is
      // constructed inside the shared gate, which is exactly where the two are
      // indistinguishable. Every message that CAN name its caller does; this one cannot
      // do so honestly, so it names none.
      "the starved-frontier sentinel escaped the helper — requireUnstarvedFrontier() may only be called synchronously from the observe() body, never from a listener, timer, or deferred callback"
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
 * Siblings with `StarvedFrontier`, NOT a parent of it: the `!(error instanceof
 * StarvedFrontier)` rethrow below must keep seeing the sentinel as its own thing.
 */
class HelperRefusal extends Error {}

/** The two public forms. Interpolated into every refusal so a message names its caller. */
type UnstarvedCaller = "withUnstarvedFrontier" | "withUnstarvedFrontierState";

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
 * The attempt loop and every refusal both public forms share. Private: the forms differ
 * only in what they own (a mounted view, or nothing) and in how each words its final
 * "what you handed back is what you gated" check, and both of those are expressed as
 * parameters here so the control flow — the per-attempt abandon and the trailing
 * all-starved throw — exists once.
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
   * once per ATTEMPT. `teardown` receives whether a failure is already in flight, so a
   * teardown failure can be reported BESIDE that failure rather than over it — a throwing
   * `finally` discards the pending exception outright rather than chaining it.
   * A `begin` that THROWS owes the disposal of whatever it had already constructed: no
   * teardown ever reached this loop.
   */
  begin: () => { context: C; teardown: (propagating: boolean) => void };
  /** The measurement. Receives the gate, which must be handed the state it speaks for. */
  observe: (context: C, gate: (state: EditorState) => void) => R;
  /**
   * The "what you handed back is what you gated" check, in the outer form's own terms. Run
   * after this loop's own refusals — so an async or ungated `observe` is reported as such
   * rather than as a mismatch — and before teardown, so it can still read the fixture.
   */
  postCheck: (context: C, stateAtLastGate: EditorState, returned: R) => void;
}): void {
  const { caller, what, attempts, begin, observe, postCheck } = spec;
  // A non-positive or fractional count would fall straight through to the all-starved
  // throw, whose message would then claim a starved frontier was FOUND on attempts that
  // never ran — the one message here that must not lie about what was measured.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`${caller}: attempts must be a positive integer, got ${attempts}`);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { context, teardown } = begin();
    // The state as of the LAST gate call, and — because the gate always sets it — also the
    // record of WHETHER the gate ever fired. One variable rather than a separate boolean:
    // they were always set together, and two names for one fact is one more thing a later
    // edit can leave half-updated.
    let stateAtLastGate: EditorState | undefined;
    // COUNTED, not a boolean. At most ONE sentinel can escape an attempt, so a count above
    // what escaped proves an earlier one was swallowed — which the return-path check alone
    // cannot see when observe() swallows and then throws.
    let sentinelsThrown = 0;
    let propagating = false;
    try {
      const returned = observe(context, (state) => {
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
        // actual cause, and does not retry. That is the intended direction — it is the
        // same misattribution this helper exists to prevent, one gate later — but nothing
        // in the suite exercises it: every `Compartment` fixture here swaps one real
        // `Language` for another, so this paragraph is the reasoning, not a pinned fact.
        assertHasLanguage(state, caller);
        stateAtLastGate = state;
        if (!syntaxTreeAvailable(state, state.doc.length)) {
          sentinelsThrown++;
          throw new StarvedFrontier();
        }
      });
      // An async `observe` would silently break every guarantee here: the loop reaches this
      // line at the callback's first `await`, tears the fixture down out from under the
      // rest of it, and reports success. Checked BEFORE the two flags: an async callback
      // suspended before its gate is also ungated, and reporting it as ungated would send
      // the reader to the wrong bug.
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
      // The sentinel is absorbed: the attempt is retried, nothing is in flight any more, so
      // a teardown failure below IS the failure and must propagate.
      propagating = false;
    } finally {
      teardown(propagating);
    }
  }
  throw new Error(
    `${caller}: all ${attempts} attempts found a starved parse frontier, so ${what} was never observed`
  );
}

/**
 * Run a single bounded-path observation against a freshly mounted view, retrying from a
 * FRESH view whenever the parse frontier came back starved, and THROWING if every attempt
 * was starved.
 *
 * Why this exists at all. Several tests observe a CodeMirror field's bounded (reuse) path
 * by dispatching one small edit on a fully-parsed view and then reading the field BEFORE
 * anything settles — the whole point being that a self-heal must not mask a bounded bug.
 * That observation is only meaningful when the post-edit parse frontier is COMPLETE,
 * because `syntaxTreeAvailable` is the very predicate those fields OR with their
 * structural-reparse check to choose between the bounded recompute and the full walk. So
 * each of them gates on it.
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
 * control flow — a `continue` here, a final `throw` there — and control flow is exactly
 * what a copied loop loses first: ./settled-view.ts documents how this suite's per-file
 * `forceParse` wrappers mostly dropped the same boolean check. Putting the loop where an
 * author using it cannot omit the all-starved throw is the same answer to the same
 * problem. What stays at the call site is the site-specific part: what to mount, what to
 * dispatch, where the frontier must be complete, and what to assert.
 *
 * SCOPE: this module owns BOTH forms of the loop, and every instance of it in the suite
 * now routes through one of them. `withUnstarvedFrontier` is for a mounted view;
 * `withUnstarvedFrontierState` is for a bare `EditorState` driven through
 * `state.update()`, which has no view to mount or destroy. They share one attempt loop
 * (`runUnstarvedAttempts`) precisely because the properties worth having — the per-attempt
 * abandon and the trailing all-starved throw — live in control flow, which is what a
 * copied loop loses first.
 *
 * Both forms make the same final claim — what you HAND BACK at the end is what you last
 * gated — and reach it differently, because they own different things. The view form owns
 * the view, so it reads `view.state` after `observe` returns. The state form owns nothing
 * and never sees the caller's local variable, so it REQUIRES `observe` to return the state
 * its assertions read and compares that.
 *
 * ⚠️ Two gaps that claim deliberately leaves open, in BOTH forms. An INTERMEDIATE state
 * no gate witnessed is invisible — `update A; update B; gate` passes while leaving A
 * unverified — so gate after every update the assertions depend on. And an `observe` that
 * derives a third state, asserts on THAT, and hands back the gated one passes too: what is
 * compared is the handed-back state, which is the most either form can see from outside
 * the callback. Neither gap is new machinery to be added later; they are the boundary of
 * what a wrapper around an opaque callback can know.
 *
 * ⚠️ Do NOT wrap `requireUnstarvedFrontier()` in a `try`/`catch` of your own, and do not
 * run it inside `expect(...).toThrow(...)`. Either swallows the sentinel, and a swallowed
 * sentinel is exactly the silent skip this helper exists to prevent. This is not left as
 * etiquette: the gate records that it fired, and a swallowed signal is refused below.
 *
 * OWNERSHIP (the VIEW form only — the state form constructs nothing and an `EditorState`
 * needs no disposal): that form constructs the parent element and calls `mount`, so it
 * owes both a teardown and discharges it on every path — success, starvation, and a propagating
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
// three shapes actually written at the call sites (a block body, a bare `return;`, and the
// concise void expression `(_v, gate) => gate()`), all of which infer `void`.
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
   * ⚠️ A gate speaks ONLY for the frontier at the instant it runs. It says nothing about
   * whether any EARLIER dispatch ran bounded — not just the one before last. The shape to
   * avoid is any dispatch whose bounded run no gate ever witnessed; `dispatch A; dispatch
   * B; gate()` is the clearest instance, satisfying every refusal below while leaving A
   * unverified, because a starved A self-heals with a full walk and an oracle comparison
   * then goes green having exercised nothing. Unlike a swallowed signal, which is refused
   * structurally, this is NOT enforced: gate after EVERY dispatch. Every call site does
   * today; a guard that removes the need to remember is tracked in the TODO.
   */
  observe: (view: EditorView, requireUnstarvedFrontier: () => void) => R;
  /** Attempts before giving up and throwing. Five, matching PR #388's measured loop. */
  attempts?: number;
}): void {
  const { what, mount, observe, attempts = 5 } = options;
  runUnstarvedAttempts<EditorView, R>({
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
      return {
        context: view,
        teardown: (propagating) => {
          // Two statements in one teardown are NOT "discharged on every path": a throwing
          // view.destroy() (CM does NOT guard widget destroy — WidgetView.destroy calls
          // widget.destroy(dom) bare, and this suite mounts table + fenced-code widgets
          // that implement it) would skip parent.remove(), leaving the view attached to
          // the shared happy-dom body for the rest of the file. Nesting keeps the parent
          // removal unconditional. A throwing destroy is a real defect and still reds the
          // run — but it must not REPLACE a failure that was already propagating, so it is
          // reported beside that failure rather than over it.
          try {
            view.destroy();
          } catch (destroyError) {
            if (!propagating) {
              throw destroyError;
            }
            console.error(
              "withUnstarvedFrontier: view.destroy() ALSO threw during teardown; the failure being reported is the primary one",
              destroyError
            );
          } finally {
            parent.remove();
          }
        },
      };
    },
    observe: (view, gate) => {
      // Once per attempt, BEFORE observe runs, and deliberately in addition to the gate's
      // own copy: a language-less view must fail as "no language configured" rather than
      // letting `observe` run up to its first gate and surface whatever it fails on first.
      // Separating that here keeps a misconfigured extension list from masquerading as N
      // starved attempts and then being reported as CPU starvation.
      assertHasLanguage(view.state, "withUnstarvedFrontier");
      return observe(view, () => gate(view.state));
    },
    postCheck: (view, stateAtLastGate) => {
      // A gate speaks only for the frontier that existed when it ran, so a state replaced
      // AFTER the last one leaves what was actually measured ungated — on a starved
      // frontier that is a full walk compared against a full walk, i.e. the vacuous green
      // this helper exists to refuse.
      //
      // Compared by IDENTITY rather than by intercepting `dispatch`, because the question
      // is WHAT was measured, not how it changed: whatever put a different state on the
      // view fails the same comparison, and reads (`view.state.field(...)`, a separate
      // `settledState(...)` oracle) leave it alone and pass. The message says "replaced
      // its state" rather than "dispatched" because that is what this observes:
      // `EditorView.setState()` replaces the state without dispatching.
      if (view.state !== stateAtLastGate) {
        throw new HelperRefusal(
          `withUnstarvedFrontier: observe() replaced its state after the last requireUnstarvedFrontier() call, so ${what} was measured on an ungated frontier`
        );
      }
    },
  });
}

export function withUnstarvedFrontierState(options: {
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
   * the assertions depend on.
   */
  observe: (requireUnstarvedFrontier: (state: EditorState) => void) => EditorState;
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
