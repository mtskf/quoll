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
      "withUnstarvedFrontier: the starved-frontier sentinel escaped the helper — requireUnstarvedFrontier() may only be called synchronously from the observe() body, never from a listener, timer, or deferred callback"
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

/**
 * Shared by the two swallow detections below — the return path cannot see a swallow that
 * is followed by a throw, and the catch path cannot see one that is followed by a return,
 * so both need to say the same thing.
 */
const SWALLOWED_SENTINEL_MESSAGE =
  "withUnstarvedFrontier: observe() swallowed the starved-frontier signal — do not wrap requireUnstarvedFrontier() in your own catch, and do not run it inside expect(...).toThrow()";

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
 * SCOPE: this helper owns the MOUNTED-VIEW form of the loop, and does not yet own every
 * instance of it. Sites that drive a bare `EditorState` through `state.update()`
 * (fenced-code/cm-fenced-code-collapse.test.ts's `untilCompleteFrontier`) cannot use it —
 * they have no view to mount or destroy — and keep their own loop until a state-side twin
 * earns its own module. ../cm-block-widget-bounded.test.ts's `checkEquivalence` IS
 * view-based and migratable; it is left for a follow-up so this PR stays one purpose.
 * Neither is visible to test/build/no-bare-unstarved-gate.test.ts, which by design sees
 * only the bare `expect(...).toBe(true)` shape.
 *
 * ⚠️ Do NOT wrap `requireUnstarvedFrontier()` in a `try`/`catch` of your own, and do not
 * run it inside `expect(...).toThrow(...)`. Either swallows the sentinel, and a swallowed
 * sentinel is exactly the silent skip this helper exists to prevent. This is not left as
 * etiquette: the gate records that it fired, and a swallowed signal is refused below.
 *
 * OWNERSHIP: this helper constructs the parent element and calls `mount`, so it owes both
 * a teardown and discharges it on every path — success, starvation, and a propagating
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
// and admits the async form again. The runtime thenable probe below stays as the backstop
// for a fixture cast through a wider type.
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
  // A non-positive or fractional count would fall straight through to the all-starved
  // throw, whose message would then claim a starved frontier was FOUND on attempts that
  // never ran — the one message here that must not lie about what was measured.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`withUnstarvedFrontier: attempts must be a positive integer, got ${attempts}`);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let view: EditorView;
    try {
      view = mount(parent);
    } catch (error) {
      parent.remove();
      throw error;
    }
    let gated = false;
    // The state as of the LAST gate call. A gate is only meaningful for the frontier that
    // existed when it ran, so a state replaced AFTER the last one leaves what was actually
    // measured ungated — on a starved frontier that is a full walk compared against a full
    // walk, i.e. the vacuous green this helper exists to refuse.
    //
    // Compared by IDENTITY rather than by intercepting `dispatch`, because the question is
    // WHAT was measured, not how it changed: whatever put a different state on the view
    // fails the same comparison, and reads (`view.state.field(...)`, a separate
    // `settledState(...)` oracle) leave it alone and pass. That is the whole claim — it
    // rests on this comparison and nothing else, so no argument about what could or could
    // not have moved the state in the meantime is needed, or would be pinned if made.
    let stateAtLastGate: EditorState | undefined;
    // COUNTED, not a boolean, and hoisted OUT of the try so the catch can read it too. At
    // most ONE sentinel can escape an attempt, so a count above what escaped proves an
    // earlier one was swallowed — which the return-path check alone cannot see when
    // observe() swallows and then throws (its own assertion, or a second sentinel).
    let sentinelsThrown = 0;
    // Whether a failure is in flight as the `finally` below runs. A throwing `finally`
    // DISCARDS the pending exception outright — it does not chain it, and the replacement
    // carries no `cause` — so a teardown failure would surface INSTEAD of the assertion diff
    // this helper exists to show, in a suite that mounts exactly the widgets whose destroy
    // can throw. Nesting the teardown fixes only the parent-removal half of that; this flag
    // is the other half.
    let propagating = false;
    try {
      // A false gate ALSO means "no Language extension attached". Separating that here,
      // once per attempt, keeps a misconfigured extension list from masquerading as five
      // starved attempts and then being reported as CPU starvation.
      assertHasLanguage(view.state, "withUnstarvedFrontier");
      const returned: unknown = observe(view, () => {
        gated = true;
        stateAtLastGate = view.state;
        if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
          sentinelsThrown++;
          throw new StarvedFrontier();
        }
      });
      // An async `observe` is accepted by TypeScript (a `void`-returning callback type
      // permits any return value) and would silently break every guarantee here: the
      // helper reaches this line at the callback's first `await`, destroys the view out
      // from under the rest of it, and reports success. A sentinel thrown after that point
      // would miss the catch below entirely.
      //
      // Checked BEFORE the two flags: an async callback suspended before its gate is also
      // `!gated`, and reporting it as "ungated" would send the reader to the wrong bug.
      // All three are refused; only the message differs.
      if (typeof (returned as { then?: unknown } | undefined)?.then === "function") {
        // Detach the abandoned continuation before throwing. It resumes on a later
        // microtask against a view the `finally` below is about to destroy, and an
        // assertion failure there would surface as an unhandled rejection during an
        // unrelated, later test — a red with no connection to its cause. Nothing is lost:
        // the observation it belonged to is already being refused by the throw.
        //
        // `Promise.resolve(...)` rather than `returned.catch(...)`: the condition above
        // admits ANY thenable, and a thenable is only required to have `.then`. Calling
        // `.catch` on a `.then`-only object throws a TypeError that would replace the
        // clear message below with a confusing one.
        void Promise.resolve(returned).catch(() => {});
        // HelperRefusal, here and on the three throws below: the catch's swallow check must
        // wrap only what came out of `observe`, never a refusal the helper raised itself —
        // which would relabel the helper's own diagnosis. `HelperRefusal`'s docblock names
        // the two distinct ways that goes wrong. Some of the four can reach that check with
        // a non-zero `sentinelsThrown`, so their marking is load-bearing; all four carry it
        // so that "the helper never relabels its own refusals" holds structurally, by the
        // class of the error, rather than resting on which counter values each throw site
        // happens to be reachable with — an argument a later edit voids silently.
        throw new HelperRefusal(
          "withUnstarvedFrontier: observe() must be synchronous — an async callback is destroyed mid-flight and its assertions never gate the result"
        );
      }
      // The gate FIRED but `observe` returned anyway, so the sentinel was caught inside the
      // callback — a `try {} catch {}` around the gate, or an `expect(...).toThrow()`
      // wrapping it. `gated` alone cannot see this, being set before the throw. Without
      // this check a swallowed sentinel reads as a successful observation on a starved
      // view.
      if (sentinelsThrown > 0) {
        throw new HelperRefusal(SWALLOWED_SENTINEL_MESSAGE);
      }
      // An `observe` that never reached the gate measured an UNGATED view, which is the
      // vacuous pass this helper exists to prevent: on a starved frontier the field
      // self-heals with a full walk, so an oracle comparison would compare a full walk to
      // a full walk and go quietly green having exercised no bounded path. The identity
      // sites would merely red; the oracle sites would LIE. Checked after `observe`
      // returns, because only then is "never called" distinguishable from "not yet".
      if (!gated) {
        throw new HelperRefusal(
          `withUnstarvedFrontier: observe() returned without calling requireUnstarvedFrontier(), so ${what} was measured on an ungated view`
        );
      }
      // …and a gate that fired but was then made obsolete is the same vacuity wearing a
      // passing gate. See `stateAtLastGate` above. The message says "replaced its state"
      // rather than "dispatched" because that is what the identity check actually observes:
      // `EditorView.setState()` replaces the state without dispatching, and naming the
      // wrong cause in a refusal would send the reader hunting for a dispatch that is not
      // there.
      if (view.state !== stateAtLastGate) {
        throw new HelperRefusal(
          `withUnstarvedFrontier: observe() replaced its state after the last requireUnstarvedFrontier() call, so ${what} was measured on an ungated frontier`
        );
      }
      return;
    } catch (error) {
      propagating = true;
      if (
        !(error instanceof HelperRefusal) &&
        sentinelsThrown > (error instanceof StarvedFrontier ? 1 : 0)
      ) {
        throw new Error(SWALLOWED_SENTINEL_MESSAGE, { cause: error });
      }
      if (!(error instanceof StarvedFrontier)) {
        throw error;
      }
      // The sentinel is absorbed: the attempt is retried, nothing is in flight any more, so
      // a teardown failure below IS the failure and must propagate.
      propagating = false;
    } finally {
      // Two statements in one `finally` are NOT "discharged on every path": a throwing
      // view.destroy() (CM does NOT guard widget destroy — WidgetView.destroy calls
      // widget.destroy(dom) bare, and this suite mounts table + fenced-code widgets that
      // implement it) would skip parent.remove(), leaving the view attached to the shared
      // happy-dom body for the rest of the file. Nesting keeps the parent removal
      // unconditional. A throwing destroy is a real defect and still reds the run — but it
      // must not REPLACE a failure that was already propagating, so it is reported beside
      // that failure rather than over it.
      try {
        view.destroy();
      } catch (destroyError) {
        if (!propagating) {
          // The rule's harm is a `finally` throw OVERWRITING control flow from the try/catch.
          // `propagating` is the check for exactly that: this arm runs only when nothing was
          // in flight, so there is no failure to overwrite — a destroy that throws on the
          // success path is itself the failure, and the other arm below is what keeps a real
          // one primary. The suppression must be the LAST comment line or Biome ignores it.
          // biome-ignore lint/correctness/noUnsafeFinally: guarded — nothing is in flight here
          throw destroyError;
        }
        console.error(
          "withUnstarvedFrontier: view.destroy() ALSO threw during teardown; the failure being reported is the primary one",
          destroyError
        );
      } finally {
        parent.remove();
      }
    }
  }
  throw new Error(
    `withUnstarvedFrontier: all ${attempts} attempts found a starved parse frontier, so ${what} was never observed`
  );
}
