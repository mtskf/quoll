// @vitest-environment happy-dom
// Unit test for the OWN control flow of both unstarved-frontier forms — and the only place
// the refusals of the attempt loop they share (`runUnstarvedAttempts`) are exercised at all.
// The suites that call them drive the success path only, so without this file a weakening of
// any of those refusals — the all-starved throw above all, which is the one thing keeping an
// attempt loop from degrading into a silent skip — stays silently green.
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { timeoutMessage, truncatedSnapshotMessage } from "./parse-to-end.js";
import { settledState } from "./settled-state.js";
import { settledMount } from "./settled-view.js";
import { neverFinishingLanguage } from "./stub-parsers.js";
import { withUnstarvedFrontier, withUnstarvedFrontierState } from "./unstarved-frontier.js";

const DOC = "# h\n\nbody\n";

/** A view whose frontier is COMPLETE: real language, settled to the document end. */
function settledMarkdown(parent: HTMLElement): EditorView {
  return settledMount({
    state: EditorState.create({ doc: DOC, extensions: [markdown()] }),
    parent,
  });
}

/**
 * A view whose frontier is permanently STARVED. `neverFinishingLanguage()` never
 * completes, so `syntaxTreeAvailable(state, doc.length)` is false forever — the
 * deterministic stand-in for the descheduled-process case the real loop exists for. It is
 * deliberately NOT settled (settling it would throw); the helper only requires that
 * `mount` hand back a mounted view.
 */
function starvedMount(parent: HTMLElement): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc: DOC, extensions: [neverFinishingLanguage()] }),
  });
}

/**
 * A frontier complete near the START and starved at the END — the one shape here that is
 * neither all-parsed nor all-starved, and the only thing that pins the gate's `upto` to the
 * DOCUMENT end. CodeMirror parses only its init viewport at mount and defers the rest to a
 * worker that a synchronous test never lets run, so a document far longer than that viewport
 * settles at the front and stops. Without this, weakening the gate from `doc.length` to any
 * smaller position passes every test in the file and every consuming suite (measured at 1).
 *
 * ⚠️ Coupled to a CM-private constant (the init-viewport size). If upstream changes it this
 * fixture stops being partial and quietly reverts to all-parsed — retire it rather than
 * chasing the number. The same caution `stub-parsers.ts` gives about its own coupling.
 */
function partiallyParsedMount(parent: HTMLElement): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc: "para\n\n".repeat(4_000), extensions: [markdown()] }),
  });
}

/** Count `destroy()` calls on one view without suppressing the real teardown. */
function countingDestroy(view: EditorView, tally: { n: number }): EditorView {
  const real = view.destroy.bind(view);
  view.destroy = () => {
    tally.n++;
    real();
  };
  return view;
}

/**
 * Make one view's `destroy()` throw. The message lives here alone: two mounts need this
 * behaviour, and a message duplicated per mount can drift on one side while the other
 * test's regex keeps matching the copy it was written against.
 */
function throwOnDestroy(view: EditorView): EditorView {
  const real = view.destroy.bind(view);
  view.destroy = () => {
    real(); // still tear the view down — only the throw is simulated
    throw new Error("widget destroy blew up");
  };
  return view;
}

/** A settled view whose `destroy()` still tears down for real, then throws. */
const throwingDestroyMount = (parent: HTMLElement): EditorView =>
  throwOnDestroy(settledMarkdown(parent));

/**
 * A STARVED view whose `destroy()` still tears down for real, then throws. The combination
 * is what reaches the sentinel-absorbed teardown: a starved attempt is abandoned, so
 * nothing is in flight any more and the destroy failure is the only real failure there.
 */
const starvedThrowingDestroyMount = (parent: HTMLElement): EditorView =>
  throwOnDestroy(starvedMount(parent));

/** Run `fn`, returning what it throws instead of letting it propagate. */
function catchError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * An async `observe`, which the helper must refuse. ONE `as`, not `as unknown as`: the
 * wider form erases the source type, so this fixture would keep compiling — and its claim
 * would silently become false — however `observe`'s signature changes. The narrow form
 * breaks on that day and points the next author straight here.
 */
function asAsyncObserve(
  fn: (view: EditorView, gate: () => void) => Promise<void>
): (view: EditorView, gate: () => void) => void {
  return fn as (view: EditorView, gate: () => void) => void;
}

describe("withUnstarvedFrontier retries a starved attempt from a fresh view", () => {
  it("runs the observation once, on the first unstarved attempt", () => {
    let mounts = 0;
    let observed = 0;
    withUnstarvedFrontier({
      what: "the test observation",
      mount: (parent) => (++mounts === 1 ? starvedMount(parent) : settledMarkdown(parent)),
      observe: (_view, requireUnstarvedFrontier) => {
        requireUnstarvedFrontier();
        observed++;
      },
    });
    expect(mounts).toBe(2); // attempt 1 abandoned, attempt 2 observed
    expect(observed).toBe(1); // and the observation ran exactly once
  });

  it("hands every attempt a FRESH, EMPTY parent rather than reusing one", () => {
    // "From a fresh view" is only half the guarantee — `mount`'s docblock says the fixture
    // is built from scratch each attempt, and a retry that inherited the abandoned
    // attempt's DOM would let a widget oracle compare against leftovers. Hoisting the
    // parent out of the attempt loop leaves every other test in this file green, so
    // nothing but this pins it.
    const parents: HTMLElement[] = [];
    withUnstarvedFrontier({
      what: "the test observation",
      mount: (parent) => {
        // ATTACHED, and asserted here rather than by the teardown tests: those read
        // `document.body.childElementCount` before and after and expect it unchanged, which
        // a helper that never appended satisfies exactly as well as one that appended and
        // then removed. That symmetry makes "the parent was removed" unobservable without
        // first pinning "the parent was there" — a self-cancelling pair of the kind this
        // helper exists to refuse.
        //
        // `document.body` specifically, not merely connected: the teardown oracles count
        // body's DIRECT children, so appending anywhere else would leave both them and an
        // `isConnected` check green.
        expect(parent.parentElement).toBe(document.body);
        expect(parent.childElementCount).toBe(0); // nothing carried over
        expect(parents).not.toContain(parent); // and not the same element again
        parents.push(parent);
        return parents.length === 1 ? starvedMount(parent) : settledMarkdown(parent);
      },
      observe: (_view, requireUnstarvedFrontier) => {
        requireUnstarvedFrontier();
      },
    });
    expect(parents).toHaveLength(2); // the starved attempt really was retried
  });
});

describe("the gate speaks for the DOCUMENT end, not for the part already parsed", () => {
  it("refuses a frontier that is complete at the front and starved at the tail", () => {
    // Every other fixture here is all-or-nothing, so the gate's `upto` argument was free to
    // shrink: weakening it from `doc.length` to 1 left every other test in this file and the
    // consuming suites green (measured). This is the only shape that tells the difference, and
    // it is what "unstarved" is supposed to mean.
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: partiallyParsedMount,
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier(); // must NOT return — the tail is unparsed
        },
      })
    ).toThrow(/all 2 attempts found a starved parse frontier/);
  });
});

describe("an all-starved run FAILS rather than passing having measured nothing", () => {
  it("throws, naming the attempt count and what was never observed", () => {
    let observedPastTheGate = 0;
    expect(() =>
      withUnstarvedFrontier({
        what: "verbatim bounded reuse",
        attempts: 3,
        mount: starvedMount,
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          observedPastTheGate++;
        },
      })
    ).toThrow(
      /^withUnstarvedFrontier: all 3 attempts found a starved parse frontier, so verbatim bounded reuse was never observed/
    );
    expect(observedPastTheGate).toBe(0);
  });
});

describe("an observation that never consults the gate is refused", () => {
  // The ungated case is the one that can LIE. An oracle comparison on a starved frontier
  // compares a self-healed full walk to a full walk and goes green having measured nothing.
  it("throws when observe() returns without calling requireUnstarvedFrontier()", () => {
    expect(() =>
      withUnstarvedFrontier({
        // A DISTINCTIVE `what`, not this file's usual generic one: the refusal interpolates
        // it, and every other fixture passing the same generic phrase let a mutant that
        // hard-coded that phrase in place of `${what}` survive (measured). A value no
        // hard-coding would guess is what makes the interpolation observable.
        what: "an ungated widget census",
        mount: settledMarkdown,
        observe: () => {
          /* measures something, but never gates it */
        },
      })
    ).toThrow(
      /observe\(\) returned without calling requireUnstarvedFrontier\(\), so an ungated widget census was measured on an ungated view/
    );
  });

  it("does not retry the ungated case — it is a test bug, not a starved machine", () => {
    let mounts = 0;
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: (parent) => {
          mounts++;
          return settledMarkdown(parent);
        },
        observe: () => {},
      })
    ).toThrow();
    expect(mounts).toBe(1);
  });
});

describe("an async observe is refused rather than silently half-run", () => {
  // TypeScript permits it (a void-returning callback type accepts any return value), and
  // the helper would otherwise return at the first await, destroying the view out from
  // under the assertions that had not run yet.
  it("throws when observe() returns a thenable", () => {
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: settledMarkdown,
        observe: asAsyncObserve(async (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        }),
      })
    ).toThrow(/observe\(\) must be synchronous/);
  });

  it("names the async bug even when the callback gated before its first await", () => {
    // The gate fires, throws the sentinel INSIDE the still-suspended callback, and the
    // helper reaches its thenable check with sentinelsThrown at 1 — which is also what a
    // swallow looks like from the catch. Without the helper marking its own refusals, the
    // "must be synchronous" message (checked first precisely so the reader is sent to the
    // right bug) is relabelled as swallow advice.
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: starvedMount,
        observe: asAsyncObserve(async (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier(); // starved → throws before any await runs
          await Promise.resolve();
        }),
      })
    ).toThrow(/observe\(\) must be synchronous/);
  });

  it("refuses a bare `.then`-only thenable without tripping over its missing .catch", () => {
    // The detection admits ANY thenable, and a thenable need only have `.then`. Reaching
    // for `.catch` on one would raise a TypeError that replaced the message below with a
    // confusing one, so the helper routes through Promise.resolve().
    const thenOnly = {
      // A deliberate bare thenable IS the fixture here; the rule below guards against
      // creating one by accident, which is the opposite of what this test needs. The
      // suppression has to be the LAST comment line before the code, or Biome reports it
      // as unused and the rule still fires.
      // biome-ignore lint/suspicious/noThenProperty: the fixture must be a bare thenable
      then(resolve: () => void) {
        resolve();
      },
    };
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: settledMarkdown,
        // ONE `as`, for the reason given on asAsyncObserve above.
        observe: ((_view: EditorView, requireUnstarvedFrontier: () => void) => {
          requireUnstarvedFrontier();
          return thenOnly;
        }) as (view: EditorView, gate: () => void) => void,
      })
    ).toThrow(/observe\(\) must be synchronous/);
  });

  it("refuses an async observe at COMPILE time, not only at runtime", () => {
    // The runtime probe above catches a fixture smuggled in through a cast. This pins the
    // cheaper half: `observe`'s constrained return type makes the UNCAST async form an
    // error. The directive is self-verifying — relax the constraint back to a literal
    // `void` and TypeScript reports it as unused, so `pnpm compile` reds.
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: settledMarkdown,
        // @ts-expect-error an async observe returns Promise<void>, which R refuses
        observe: async (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow(/observe\(\) must be synchronous/);
  });
});

describe("this helper is not a settling caller, and the type says so", () => {
  it("is refused by the two parse-budget messages at COMPILE time", () => {
    // ./parse-to-end.ts narrows both message builders to `SettlingCaller`, which EXCLUDES
    // this helper: it probes for a language and never advances a parse, so neither sentence
    // about a parse budget could honestly carry its name. Nothing else pins that narrowing
    // — widening it back to `ParseCaller` left every suite green (measured).
    //
    // One positive control per builder first, so each directive below is known to be
    // refusing this helper's NAME rather than a call shape that was broken anyway:
    expect(timeoutMessage("settledView", 5, 9)).toContain("settledView");
    expect(truncatedSnapshotMessage("settledView", 0, 9)).toContain("settledView");
    // The directives are self-verifying in the other direction: widen `SettlingCaller` and
    // TypeScript reports both as unused, so `pnpm compile` reds.
    // @ts-expect-error withUnstarvedFrontier advances no parse, so it is not a SettlingCaller
    timeoutMessage("withUnstarvedFrontier", 5, 9);
    // @ts-expect-error ditto: the snapshot message is about a parse this helper never ran
    truncatedSnapshotMessage("withUnstarvedFrontier", 0, 9);
  });
});

describe("every gate call re-reads the frontier, not just the first", () => {
  // The callout suite's edit loop gates once per dispatch and requires the frontier to be
  // complete on THIS dispatch — a gate answering from a cached first reading would let a
  // starved LATER dispatch through and compare a full walk to a full walk. Every fixture
  // there is single-edit today, so only this test covers the property.
  it("abandons the attempt when a LATER gate call finds a starved frontier", () => {
    let reachedSecond = 0;
    let reachedPast = 0;
    const lang = new Compartment();
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: (parent) =>
          settledMount({
            state: EditorState.create({ doc: DOC, extensions: [lang.of(markdown())] }),
            parent,
          }),
        observe: (view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier(); // settled markdown → complete
          // Swap in the never-finishing parser: the NEXT frontier read is starved
          // deterministically, with no dependence on wall-clock timing. (A large insert
          // does NOT work — 88k chars still parse inside the 20ms budget under happy-dom.)
          view.dispatch({ effects: lang.reconfigure(neverFinishingLanguage()) });
          reachedSecond++;
          requireUnstarvedFrontier(); // must NOT return
          reachedPast++;
        },
      })
    ).toThrow(/all 2 attempts found a starved parse frontier/);
    expect(reachedSecond).toBe(2); // both attempts got as far as the second gate
    expect(reachedPast).toBe(0); // and neither got past it
  });

  it("names a language lost MID-attempt instead of retrying it as starvation", () => {
    // The sibling above swaps one real Language for another, so it cannot tell a per-GATE
    // language check from a per-ATTEMPT one. Reconfiguring to `[]` can: `syntaxTreeAvailable`
    // is ALSO false with no Language attached, so a check that had already run once per
    // attempt would read the second gate as starvation, retry, and end the run blaming the
    // CPU. The second gate must throw "no language configured" and NOT retry. Measured: with
    // the check narrowed to the first gate call this reds, and nothing else in the file does.
    const lang = new Compartment();
    let mounts = 0;
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 3,
        mount: (parent) => {
          mounts++;
          return settledMount({
            state: EditorState.create({ doc: DOC, extensions: [lang.of(markdown())] }),
            parent,
          });
        },
        observe: (view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          view.dispatch({ effects: lang.reconfigure([]) });
          requireUnstarvedFrontier(); // must NOT be read as starvation
        },
      })
    ).toThrow(/^withUnstarvedFrontier: state has no language configured/);
    expect(mounts).toBe(1); // and NOT retried
  });
});

describe("a state replacement after the LAST gate is refused", () => {
  // A gate speaks only for the frontier that existed when it ran. Gating first and
  // replacing the state afterwards passes every other refusal here — gated, unstarved,
  // synchronous — while the state actually measured was never gated at all.
  it("throws when observe() dispatches after its final requireUnstarvedFrontier()", () => {
    expect(() =>
      withUnstarvedFrontier({
        // Distinctive, for the reason given on the ungated refusal above.
        what: "a post-dispatch record compare",
        mount: settledMarkdown,
        observe: (view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          view.dispatch({ changes: { from: 0, insert: "x" } });
        },
      })
    ).toThrow(
      /replaced its state after the last requireUnstarvedFrontier\(\) call, so a post-dispatch record compare was measured on an ungated frontier/
    );
  });

  it("throws when observe() calls setState() — no dispatch, and the doc is untouched", () => {
    // The refusal claims a STATE replacement, not a dispatch, and this is the fixture that
    // makes the claim true rather than merely written. `setState` replaces `view.state`
    // without dispatching, and reusing the existing `Text` keeps `doc` identical by
    // identity — so a check weakened to compare docs, or reimplemented as a dispatch
    // interception, would let this through while the test above still passed.
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: settledMarkdown,
        observe: (view, requireUnstarvedFrontier) => {
          // Instrument BEFORE the gate: the refusal under test speaks for the last gate, so
          // the control dispatch has to land before it or it would itself be the violation.
          let dispatches = 0;
          const realDispatch = view.dispatch.bind(view);
          view.dispatch = ((...args: Parameters<typeof realDispatch>) => {
            dispatches++;
            return realDispatch(...args);
          }) as typeof view.dispatch;
          view.dispatch({ changes: { from: 0, insert: "x" } });
          expect(dispatches).toBe(1); // the counter works…
          requireUnstarvedFrontier();
          const replacement = EditorState.create({ doc: view.state.doc, extensions: [markdown()] });
          // WITHOUT the next line, this test's discriminating power would rest on the doc
          // surviving by IDENTITY with nothing observing it: rewriting `doc: view.state.doc`
          // to `doc: DOC` still replaces the state, so the test would stay green while the
          // doc-comparison mutant it exists to kill came back to life (measured before this
          // assertion existed). Asserted inside the fixture rather than as its own `it`,
          // because a separate test would not be coupled to the state this one passes on.
          expect(replacement.doc).toBe(view.state.doc);
          // The other half of the same dependency: this fixture kills the
          // dispatch-interception mutant only because setState does NOT dispatch. Counted
          // rather than assumed, and counted with a POSITIVE CONTROL first — an unwired
          // counter reads zero just as convincingly as a working one, which is the
          // self-cancelling shape this file refuses a few tests above.
          view.setState(replacement);
          expect(dispatches).toBe(1); // …and setState added nothing to it
        },
      })
    ).toThrow(
      /replaced its state after the last requireUnstarvedFrontier\(\) call, so the bounded output was measured on an ungated frontier/
    );
  });

  it("accepts a second gate that follows a dispatch — the gate-per-dispatch shape", () => {
    // The refusal speaks for the LAST gate, so re-gating after a dispatch must re-arm it.
    // Every other multi-gate test here ends on a STARVED second gate, which throws before
    // the identity check runs; only this one exercises its accepting arm.
    let past = 0;
    withUnstarvedFrontier({
      what: "the bounded output",
      mount: settledMarkdown,
      observe: (view, requireUnstarvedFrontier) => {
        requireUnstarvedFrontier();
        view.dispatch({ changes: { from: 0, insert: "x" } });
        requireUnstarvedFrontier();
        past++;
      },
    });
    expect(past).toBe(1);
  });

  it("still accepts reading the view after the gate, which is the normal shape", () => {
    // The refusal compares state IDENTITY, so it must not fire on the ordinary shape the
    // call sites use: reading `view.state` (and settling a separate oracle state) after
    // gating. Counting them here would be one more undated census to go stale.
    withUnstarvedFrontier({
      what: "the test observation",
      mount: settledMarkdown,
      observe: (view, requireUnstarvedFrontier) => {
        requireUnstarvedFrontier();
        expect(view.state.doc.toString()).toBe(DOC);
      },
    });
  });
});

describe("an attempt count that could not have measured anything is refused", () => {
  it("throws rather than reporting a starved frontier on attempts that never ran", () => {
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 0,
        mount: settledMarkdown,
        observe: (_view, requireUnstarvedFrontier) => requireUnstarvedFrontier(),
      })
    ).toThrow(/attempts must be a positive integer, got 0/);
  });

  it("throws on a FRACTIONAL count, which the `< 1` arm alone would let through", () => {
    // Separate from the case above because they exercise different arms of the same guard:
    // `NaN < 1` is false, so only `Number.isInteger` refuses either of these.
    //
    // Why the guard is worth having: `attempts` reaches the loop bound and the all-starved
    // message unchecked, and neither can represent a fractional or NaN count honestly —
    // `attempt < 2.5` admits 0, 1 and 2, and `attempt < NaN` admits nothing at all, while
    // the message reports the raw value either way. The guard's own comment calls that the
    // one message here that must not lie about what was measured, so the count is refused
    // at the door rather than carried into a sentence that cannot be true.
    for (const attempts of [2.5, Number.NaN]) {
      expect(() =>
        withUnstarvedFrontier({
          what: "the bounded output",
          attempts,
          mount: settledMarkdown,
          observe: (_view, requireUnstarvedFrontier) => requireUnstarvedFrontier(),
        })
      ).toThrow(/attempts must be a positive integer/);
    }
  });
});

describe("a swallowed starved-frontier signal is refused", () => {
  // A call site that wraps the gate in its own catch would turn a starved frontier into a
  // successful-looking observation. `stateAtLastGate` cannot see this — the gate records the
  // state BEFORE throwing the sentinel, so a swallowed one leaves the attempt looking gated
  // — so the helper COUNTS the sentinels it threw instead.
  it("throws when observe() catches the sentinel and returns anyway", () => {
    const caught = catchError(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: starvedMount,
        observe: (_view, requireUnstarvedFrontier) => {
          try {
            requireUnstarvedFrontier();
          } catch {
            /* exactly the mistake this test pins */
          }
        },
      })
    );
    expect((caught as Error | undefined)?.message).toMatch(/swallowed the starved-frontier signal/);
    // …and exactly once. This refusal is raised on the RETURN path, so the catch below it
    // sees the helper's own diagnosis; wrapping it would chain a second, identical copy of
    // the same message as its cause and read as two separate findings.
    expect((caught as Error).cause).toBeUndefined();
  });

  it("throws when observe() swallows one sentinel and lets a later one escape", () => {
    // The return-path check cannot see this: observe does not RETURN, it throws — and the
    // thrown sentinel reads as an ordinary starved attempt, so the swallow is retried away
    // and the run ends blaming the CPU. Detected by COUNTING sentinels instead: only one
    // can escape an attempt, so two means one was caught.
    const caught = catchError(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: starvedMount,
        observe: (_view, requireUnstarvedFrontier) => {
          try {
            requireUnstarvedFrontier();
          } catch {
            /* exactly the mistake this test pins */
          }
          requireUnstarvedFrontier(); // the second one escapes
        },
      })
    );
    expect((caught as Error | undefined)?.message).toMatch(/swallowed the starved-frontier signal/);
    // The sentinel names and explains itself, so the chained cause is readable rather than
    // a bare `Error:` with an empty body.
    expect((caught as Error).cause).toMatchObject({
      name: "StarvedFrontier",
      message: expect.stringContaining("sentinel escaped the helper"),
    });
  });

  it("throws when observe() swallows the sentinel and then fails an assertion of its own", () => {
    // The escaping error is NOT a sentinel, so the counter alone can convict: one sentinel
    // was thrown and none escaped. This is the only test that convicts through the
    // non-sentinel arm of the catch's threshold. Without that arm, the failure surfaces as
    // the bare assertion diff below, taken on a starved frontier and carrying no hint that
    // a sentinel was swallowed — a real failure reported against a meaningless measurement,
    // which is the misattribution this helper exists to prevent.
    const caught = catchError(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        attempts: 2,
        mount: starvedMount,
        observe: (_view, requireUnstarvedFrontier) => {
          try {
            requireUnstarvedFrontier();
          } catch {
            /* exactly the mistake this test pins */
          }
          expect(1).toBe(2); // observe's OWN failure, on the ungated view
        },
      })
    );
    expect((caught as Error | undefined)?.message).toMatch(/swallowed the starved-frontier signal/);
    // Chained, not replaced: the reader still gets the assertion diff, now labelled with
    // the reason it cannot be trusted at face value. The diff itself is asserted, not just
    // its presence — `toBeDefined()` alone would survive a mutant that chained some other
    // error, and "the reader still gets the diff" is the whole claim.
    expect(((caught as Error).cause as Error).message).toMatch(/expected 1 to be 2/);
  });
});

describe("an abandoned async continuation cannot poison a later test", () => {
  // The async refusal throws while the callback is still suspended. Its resumption must
  // not surface as an unhandled rejection in whatever test happens to run next.
  it("detaches a genuinely-awaiting observe without an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      expect(() =>
        withUnstarvedFrontier({
          what: "the bounded output",
          mount: settledMarkdown,
          observe: asAsyncObserve(async (_view, requireUnstarvedFrontier) => {
            await Promise.resolve();
            requireUnstarvedFrontier(); // runs after the helper already gave up
            expect(1).toBe(2); // and would reject
          }),
        })
      ).toThrow(/observe\(\) must be synchronous/);
      // Let the abandoned continuation resume and settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("a missing language is reported as such, not retried as starvation", () => {
  // syntaxTreeAvailable is ALSO false when no Language extension is attached. Without this
  // separation the helper would burn five attempts and then blame the CPU.
  it("names the missing language instead of reporting a starved frontier", () => {
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: (parent) =>
          new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [] }) }),
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow(/^withUnstarvedFrontier: state has no language configured/);
  });
});

describe("a real failure is propagated, not retried away", () => {
  it("rethrows an assertion failure from observe() on the first attempt", () => {
    let mounts = 0;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        mount: (parent) => {
          mounts++;
          return settledMarkdown(parent);
        },
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          expect(1).toBe(2);
        },
      })
    ).toThrow();
    expect(mounts).toBe(1); // NOT retried — only a starved frontier earns another attempt
  });

  it("propagates a mount failure without retrying it", () => {
    // A mount that throws owes the disposal of anything it constructed — the helper never
    // received a reference. What the helper still owes, and discharges, is the parent.
    let mounts = 0;
    const before = document.body.childElementCount;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        mount: () => {
          mounts++;
          throw new Error("mount blew up");
        },
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow(/mount blew up/);
    expect(mounts).toBe(1);
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("every attempt cleans up after itself", () => {
  // Counting destroy() calls, not just DOM children: a helper that removed the parent but
  // skipped destroy() would pass a childElementCount-only check while leaking CM timers.
  it("destroys exactly once and removes the parent on the success path", () => {
    const tally = { n: 0 };
    const before = document.body.childElementCount;
    withUnstarvedFrontier({
      what: "the test observation",
      mount: (parent) => countingDestroy(settledMarkdown(parent), tally),
      observe: (_view, requireUnstarvedFrontier) => {
        requireUnstarvedFrontier();
      },
    });
    expect(tally.n).toBe(1);
    expect(document.body.childElementCount).toBe(before);
  });

  it("destroys once per attempt on the all-starved path", () => {
    const tally = { n: 0 };
    const before = document.body.childElementCount;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        attempts: 2,
        mount: (parent) => countingDestroy(starvedMount(parent), tally),
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow();
    expect(tally.n).toBe(2);
    expect(document.body.childElementCount).toBe(before);
  });

  it("destroys and removes the parent even when observe() throws a real failure", () => {
    const tally = { n: 0 };
    const before = document.body.childElementCount;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        mount: (parent) => countingDestroy(settledMarkdown(parent), tally),
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          throw new Error("boom");
        },
      })
    ).toThrow(/boom/);
    expect(tally.n).toBe(1);
    expect(document.body.childElementCount).toBe(before);
  });

  it("removes the parent even when view.destroy() throws", () => {
    // CM does not guard widget destroy, and this suite mounts widgets that implement it.
    // Two statements in one `finally` are sequential: a throwing destroy would strand the
    // parent on the shared happy-dom body for the rest of the file.
    const before = document.body.childElementCount;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        mount: throwingDestroyMount,
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow(/widget destroy blew up/);
    expect(document.body.childElementCount).toBe(before);
  });

  it("propagates a teardown failure from an ABANDONED attempt instead of retrying past it", () => {
    // The attempt was abandoned because the frontier was starved, so nothing is in flight
    // any more and this destroy failure IS the failure. Clearing `propagating` on the
    // sentinel-absorbed path is what says so: leave it set and the throw is written off as
    // "beside a primary failure" that no longer exists, swallowed into console.error, and
    // the loop retries — a real teardown defect then surfaces as "the CPU was busy", which
    // is the exact misattribution this helper exists to prevent.
    let mounts = 0;
    expect(() =>
      withUnstarvedFrontier({
        what: "the test observation",
        attempts: 3,
        mount: (parent) => {
          mounts++;
          return starvedThrowingDestroyMount(parent);
        },
        observe: (_view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
        },
      })
    ).toThrow(/widget destroy blew up/); // NOT "all 3 attempts found a starved parse frontier"
    expect(mounts).toBe(1); // and it stopped at the attempt that failed
  });

  it("keeps observe()'s failure primary when view.destroy() ALSO throws", () => {
    // A throwing `finally` DISCARDS the pending exception rather than chaining it, so a
    // teardown failure would surface INSTEAD of the assertion diff — in a suite that mounts
    // exactly the widgets whose destroy can throw. The destroy failure is still reported,
    // beside the primary one rather than over it.
    //
    // The message is the CORE's, not the view form's: the guard lives in the shared
    // `finally` so that every form inherits it, and the view form's teardown lets its
    // destroy failure out bare. Anchored, so a form hard-coding the other caller's prefix
    // could not satisfy this.
    const before = document.body.childElementCount;
    // Spied, not merely silenced: "beside" is half the promise, and without an assertion
    // on it the helper could swallow the teardown failure outright and stay green. (The
    // mock also keeps the expected stack trace off every passing run.)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        withUnstarvedFrontier({
          what: "the test observation",
          mount: throwingDestroyMount,
          observe: (_view, requireUnstarvedFrontier) => {
            requireUnstarvedFrontier();
            throw new Error("the real failure");
          },
        })
      ).toThrow(/the real failure/);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/^withUnstarvedFrontier: teardown ALSO threw/);
      expect((errSpy.mock.calls[0]?.[1] as Error).message).toMatch(/widget destroy blew up/);
    } finally {
      errSpy.mockRestore();
    }
    expect(document.body.childElementCount).toBe(before);
  });
});

/** A settled markdown STATE — the state-side counterpart of `settledMarkdown`. */
function settledMarkdownState(): EditorState {
  return settledState(EditorState.create({ doc: DOC, extensions: [markdown()] }));
}

/**
 * A state whose frontier is permanently STARVED, for the same reason and by the same
 * mechanism as `starvedMount` above: `neverFinishingLanguage()` never completes, so the
 * gate's `syntaxTreeAvailable` read is false forever. Deliberately NOT settled — settling
 * it would throw, and the state form never settles anything.
 */
function starvedState(): EditorState {
  return EditorState.create({ doc: DOC, extensions: [neverFinishingLanguage()] });
}

/** The real `observe` option type, so the fixture below cannot drift from it. */
type StateObserve = Parameters<typeof withUnstarvedFrontierState>[0]["observe"];

/**
 * An async `observe`, which the helper must refuse. TWO casts, where `asAsyncObserve`
 * above needs one — and the asymmetry belongs to the type system, not to this file.
 * `Promise<void>` is comparable to `void` (everything is), so the view form's fixture
 * converts in one step; `Promise<EditorState>` and `EditorState` share no members, so a
 * single `as` there is a TS2352 and `as unknown as` is the only spelling that compiles.
 *
 * What keeps the claim honest without the narrow-cast trick is the cast TARGET: it is
 * DERIVED from the option type rather than written out, so changing `observe`'s signature
 * changes this fixture's meaning with it instead of leaving a stale assertion behind.
 */
function asAsyncStateObserve(
  fn: (gate: (state: EditorState) => void) => Promise<EditorState>
): StateObserve {
  return fn as unknown as StateObserve;
}

describe("withUnstarvedFrontierState carries the same refusals without a view", () => {
  // The state form owns no fixture, so the teardown half of the view form's contract has
  // no counterpart here. What it DOES own is every refusal that keeps an attempt loop from
  // degrading into a silent skip — which is the whole reason the fenced-code reducer suite
  // stopped hand-rolling one.
  it("retries a starved attempt and observes on the first unstarved one", () => {
    let attemptsRun = 0;
    let observed = 0;
    withUnstarvedFrontierState({
      what: "the reducer's own output",
      observe: (requireUnstarvedFrontier) => {
        const state = ++attemptsRun === 1 ? starvedState() : settledMarkdownState();
        requireUnstarvedFrontier(state);
        observed++;
        return state;
      },
    });
    expect(attemptsRun).toBe(2); // attempt 1 abandoned…
    expect(observed).toBe(1); // …and the observation ran exactly once
  });

  it("throws when every attempt is starved, naming the count and what was never observed", () => {
    let observedPastTheGate = 0;
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reseed reset",
        attempts: 3,
        observe: (requireUnstarvedFrontier) => {
          const state = starvedState();
          requireUnstarvedFrontier(state);
          observedPastTheGate++;
          return state;
        },
      })
    ).toThrow(
      /^withUnstarvedFrontierState: all 3 attempts found a starved parse frontier, so the reseed reset was never observed/
    );
    expect(observedPastTheGate).toBe(0);
  });

  it("refuses an observation that never consults the gate", () => {
    // The `return true` mistake the TODO names, in this form's shape: `return state` is the
    // natural last statement, and forgetting the gate above it is the one-line slip that
    // makes an ungated comparison go quietly green. A DISTINCTIVE `what`, so the
    // interpolation is observable rather than hard-codeable.
    expect(() =>
      withUnstarvedFrontierState({
        what: "an ungated block census",
        observe: () => settledMarkdownState(),
      })
    ).toThrow(
      /observe\(\) returned without calling requireUnstarvedFrontier\(\), so an ungated block census was measured on an ungated state/
    );
  });

  it("does not report a SWALLOWED gate refusal as never having gated", () => {
    // The gate's own `assertHasLanguage` runs BEFORE either "the gate fired" record is
    // written, so a gate refused for a missing language leaves `stateAtLastGate` unset and
    // `sentinelsThrown` at zero. Swallow it and the loop would otherwise fall through to the
    // ungated branch and assert something false — that `observe` never called the gate —
    // sending the reader to look for a missing call that is right there, with the real error
    // discarded and no `cause`. Counting gate ENTRY separately is what tells the two apart.
    //
    // ⚠️ The counter, not `stateAtLastGate = state` moved above the assert: that would be
    // WORSE — a swallowed language error would then satisfy this form's
    // `returned === stateAtLastGate` post-check and the whole run would go green.
    //
    // The state form is the only reachable place for it: the view form's adapter probes for
    // a language once per attempt before `observe` runs, so a language-less view is refused
    // before any gate is entered.
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        observe: (requireUnstarvedFrontier) => {
          const state = EditorState.create({ doc: DOC, extensions: [] });
          try {
            requireUnstarvedFrontier(state);
          } catch {
            /* exactly the mistake this test pins */
          }
          return state;
        },
      })
    ).toThrow(
      /^withUnstarvedFrontierState: requireUnstarvedFrontier\(\) was called but its refusal was swallowed/
    );
  });

  it("does not retry the ungated case", () => {
    let attemptsRun = 0;
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        observe: () => {
          attemptsRun++;
          return settledMarkdownState();
        },
      })
    ).toThrow();
    expect(attemptsRun).toBe(1);
  });

  it("refuses a state UPDATED after the last gate, which is this form's whole post-check", () => {
    // The regression the fenced-code sites are one edit away from: gate, then update once
    // more, then assert. Every other refusal here is satisfied — gated, unstarved,
    // synchronous — while the state actually asserted on was never gated. The view form
    // catches this by owning the view; this form catches it by requiring `observe` to
    // return what it measured. Nothing else pins it.
    expect(() =>
      withUnstarvedFrontierState({
        // Distinctive, for the reason given on the ungated refusal above.
        what: "a post-update block census",
        observe: (requireUnstarvedFrontier) => {
          const gated = settledMarkdownState();
          requireUnstarvedFrontier(gated);
          return gated.update({ changes: { from: 0, insert: "x" } }).state;
        },
      })
    ).toThrow(
      /observe\(\) returned a state other than the one requireUnstarvedFrontier\(\) last saw, so a post-update block census was measured on an ungated frontier/
    );
  });

  it("accepts a second gate that follows an update — the gate-per-update shape", () => {
    // The refusal speaks for the LAST gate, so re-gating after an update must re-arm it.
    // Without this, "compare against the last gated state" could be satisfied by a check
    // that only ever accepted the FIRST gated state, and the call sites — which gate after
    // their final update — would be refused.
    let past = 0;
    withUnstarvedFrontierState({
      what: "the reducer's own output",
      observe: (requireUnstarvedFrontier) => {
        const first = settledMarkdownState();
        requireUnstarvedFrontier(first);
        const second = settledState(first.update({ changes: { from: 0, insert: "x" } }).state);
        requireUnstarvedFrontier(second);
        past++;
        return second;
      },
    });
    expect(past).toBe(1);
  });

  it("re-reads the frontier on every gate call, not just the first", () => {
    // The fenced-code sites gate once, but the property is the contract: a gate answering
    // from a cached first reading would let a starved LATER state through.
    let reachedSecond = 0;
    let reachedPast = 0;
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        attempts: 2,
        observe: (requireUnstarvedFrontier) => {
          requireUnstarvedFrontier(settledMarkdownState());
          reachedSecond++;
          const starved = starvedState();
          requireUnstarvedFrontier(starved); // must NOT return
          reachedPast++;
          return starved;
        },
      })
    ).toThrow(/all 2 attempts found a starved parse frontier/);
    expect(reachedSecond).toBe(2);
    expect(reachedPast).toBe(0);
  });

  it("refuses an async observe, and at COMPILE time too", () => {
    // Anchored on THIS form's prefix, not just on the sentence: one core now serves two
    // callers, so an unanchored matcher is satisfied by a `caller` hard-coded to the view
    // form's name and the state form's refusals would point at the wrong helper.
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        observe: asAsyncStateObserve(async (requireUnstarvedFrontier) => {
          const state = settledMarkdownState();
          requireUnstarvedFrontier(state);
          return state;
        }),
      })
    ).toThrow(/^withUnstarvedFrontierState: observe\(\) must be synchronous/);
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        // @ts-expect-error an async observe returns Promise<EditorState>, not EditorState
        observe: async (requireUnstarvedFrontier) => {
          const state = settledMarkdownState();
          requireUnstarvedFrontier(state);
          return state;
        },
      })
    ).toThrow(/^withUnstarvedFrontierState: observe\(\) must be synchronous/);
  });

  it("refuses a swallowed sentinel on both the return path and the escape path", () => {
    const returned = catchError(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        attempts: 2,
        observe: (requireUnstarvedFrontier) => {
          const state = starvedState();
          try {
            requireUnstarvedFrontier(state);
          } catch {
            /* exactly the mistake this test pins */
          }
          return state;
        },
      })
    );
    // Anchored on THIS form's prefix, for the reason given on the async pair above.
    expect((returned as Error | undefined)?.message).toMatch(
      /^withUnstarvedFrontierState: observe\(\) swallowed the starved-frontier signal/
    );
    expect((returned as Error).cause).toBeUndefined(); // raised on the return path

    const escaped = catchError(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        attempts: 2,
        observe: (requireUnstarvedFrontier) => {
          const state = starvedState();
          try {
            requireUnstarvedFrontier(state);
          } catch {
            /* ditto */
          }
          requireUnstarvedFrontier(state); // the second one escapes
          return state;
        },
      })
    );
    expect((escaped as Error | undefined)?.message).toMatch(
      /^withUnstarvedFrontierState: observe\(\) swallowed the starved-frontier signal/
    );
    expect((escaped as Error).cause).toMatchObject({ name: "StarvedFrontier" });
  });

  it("reports a missing language as such rather than retrying it as starvation", () => {
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        observe: (requireUnstarvedFrontier) => {
          const state = EditorState.create({ doc: DOC, extensions: [] });
          requireUnstarvedFrontier(state);
          return state;
        },
      })
    ).toThrow(/^withUnstarvedFrontierState: state has no language configured/);
  });

  it("refuses an attempt count that could not have measured anything", () => {
    for (const attempts of [0, 2.5, Number.NaN]) {
      expect(() =>
        withUnstarvedFrontierState({
          what: "the reducer's own output",
          attempts,
          observe: (requireUnstarvedFrontier) => {
            const state = settledMarkdownState();
            requireUnstarvedFrontier(state);
            return state;
          },
        })
      ).toThrow(/attempts must be a positive integer/);
    }
  });

  it("propagates a real failure on the first attempt instead of retrying it", () => {
    let attemptsRun = 0;
    expect(() =>
      withUnstarvedFrontierState({
        what: "the reducer's own output",
        observe: (requireUnstarvedFrontier) => {
          attemptsRun++;
          const state = settledMarkdownState();
          requireUnstarvedFrontier(state);
          expect(1).toBe(2);
          return state;
        },
      })
    ).toThrow();
    expect(attemptsRun).toBe(1);
  });
});

describe("neither form is a settling caller, and the type says so", () => {
  it("refuses the state form's name in the two parse-budget messages at COMPILE time", () => {
    // Same argument as the view form's pin above: this helper probes for a language and
    // never advances a parse, so neither sentence about a parse budget could honestly
    // carry its name. Both directives are self-verifying — widen `SettlingCaller` and
    // TypeScript reports them as unused, so `pnpm compile` reds.
    // @ts-expect-error withUnstarvedFrontierState advances no parse
    timeoutMessage("withUnstarvedFrontierState", 5, 9);
    // @ts-expect-error ditto: the snapshot message is about a parse this helper never ran
    truncatedSnapshotMessage("withUnstarvedFrontierState", 0, 9);
  });
});
