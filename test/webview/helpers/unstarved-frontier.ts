import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { assertHasLanguage } from "./parse-to-end.js";

/**
 * Sentinel for "this attempt's parse frontier was starved, so there was nothing to
 * observe". Private on purpose: only the `requireUnstarvedFrontier` handed to `observe`
 * constructs it, so the `catch` that abandons an attempt can never swallow a real
 * failure. An `Error` subclass rather than a thrown literal so Biome's throw rules stay
 * satisfied, and so an accidental escape surfaces with a stack.
 */
class StarvedFrontier extends Error {}

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
 * happens. The field then legitimately self-heals with a full walk, the bounded path is
 * not what ran, and a bare `expect(...).toBe(true)` reds on a fact about the machine
 * rather than about the code under test. Measured on a deliberately loaded full-suite run
 * (24 spinners on 8 cores) while PR #388 was in flight.
 *
 * ⚠️ This is NOT a retry that hides a regression, and it is NOT a silent skip either:
 *   - a genuine break in the bounded path reds EVERY attempt that gets far enough to
 *     look, because only a starved frontier is caught here — an assertion failure
 *     propagates out of the first attempt that raises it;
 *   - if every attempt is starved, nothing was measured and this THROWS, so the test can
 *     never pass by having quietly observed nothing.
 * A vitest-level `{ retry: n }` has neither property, which is why it is forbidden
 * repo-wide (`vitest.config.ts`) and why the loop is written out here instead.
 *
 * Why it is a shared helper rather than a per-file loop. Both properties above live in
 * control flow — a `continue` here, a final `throw` there — and control flow is exactly
 * what a copied loop loses first: ./settled-view.ts documents how this suite's per-file
 * `forceParse` wrappers each dropped the same boolean check. Putting the loop where an
 * author using it cannot omit the all-starved throw is the same answer to the same
 * problem. What stays at the call site is the site-specific part: what to mount, what to
 * dispatch, where the frontier must be complete, and what to assert.
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
export function withUnstarvedFrontier(options: {
  /** What the observation is, phrased to complete "…was never observed". */
  what: string;
  /** Build a mounted, settled view on the supplied parent. Use `settledMount()`. */
  mount: (parent: HTMLElement) => EditorView;
  /**
   * The measurement. Call `requireUnstarvedFrontier()` at every point where the parse
   * frontier must be complete for what follows to mean anything; it does not return when
   * the frontier is starved, abandoning the attempt instead.
   */
  observe: (view: EditorView, requireUnstarvedFrontier: () => void) => void;
  /** Attempts before giving up and throwing. Five, matching PR #388's measured loop. */
  attempts?: number;
}): void {
  const { what, mount, observe, attempts = 5 } = options;
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
    try {
      // A false gate ALSO means "no Language extension attached". Separating that here,
      // once per attempt, keeps a misconfigured extension list from masquerading as five
      // starved attempts and then being reported as CPU starvation.
      assertHasLanguage(view.state, "withUnstarvedFrontier");
      let gated = false;
      let starved = false;
      const returned: unknown = observe(view, () => {
        gated = true;
        if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
          starved = true;
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
        throw new Error(
          "withUnstarvedFrontier: observe() must be synchronous — an async callback is destroyed mid-flight and its assertions never gate the result"
        );
      }
      // The gate FIRED but `observe` returned anyway, so the sentinel was caught inside the
      // callback — a `try {} catch {}` around the gate, or an `expect(...).toThrow()`
      // wrapping it. `gated` alone cannot see this, being set before the throw. Without
      // this check a swallowed sentinel reads as a successful observation on a starved
      // view.
      if (starved) {
        throw new Error(
          "withUnstarvedFrontier: observe() swallowed the starved-frontier signal — do not wrap requireUnstarvedFrontier() in your own catch, and do not run it inside expect(...).toThrow()"
        );
      }
      // An `observe` that never reached the gate measured an UNGATED view, which is the
      // vacuous pass this helper exists to prevent: on a starved frontier the field
      // self-heals with a full walk, so an oracle comparison would compare a full walk to
      // a full walk and go quietly green having exercised no bounded path. The identity
      // sites would merely red; the oracle sites would LIE. Checked after `observe`
      // returns, because only then is "never called" distinguishable from "not yet".
      if (!gated) {
        throw new Error(
          `withUnstarvedFrontier: observe() returned without calling requireUnstarvedFrontier(), so ${what} was measured on an ungated view`
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof StarvedFrontier)) {
        throw error;
      }
    } finally {
      view.destroy();
      parent.remove();
    }
  }
  throw new Error(
    `withUnstarvedFrontier: all ${attempts} attempts found a starved parse frontier, so ${what} was never observed`
  );
}
