// @vitest-environment happy-dom
// Unit test for withUnstarvedFrontier()'s OWN control flow. The suites that call it drive
// the success path only, so without this file a weakening of any of its refusals — the
// all-starved throw above all, which is the one thing keeping an attempt loop from
// degrading into a silent skip — stays silently green.
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { settledMount } from "./settled-view.js";
import { neverFinishingLanguage } from "./stub-parsers.js";
import { withUnstarvedFrontier } from "./unstarved-frontier.js";

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
        what: "the bounded output",
        mount: settledMarkdown,
        observe: () => {
          /* measures something, but never gates it */
        },
      })
    ).toThrow(
      /observe\(\) returned without calling requireUnstarvedFrontier\(\), so the bounded output was measured on an ungated view/
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
});

describe("a state replacement after the LAST gate is refused", () => {
  // A gate speaks only for the frontier that existed when it ran. Gating first and
  // replacing the state afterwards passes every other refusal here — gated, unstarved,
  // synchronous — while the state actually measured was never gated at all.
  it("throws when observe() dispatches after its final requireUnstarvedFrontier()", () => {
    expect(() =>
      withUnstarvedFrontier({
        what: "the bounded output",
        mount: settledMarkdown,
        observe: (view, requireUnstarvedFrontier) => {
          requireUnstarvedFrontier();
          view.dispatch({ changes: { from: 0, insert: "x" } });
        },
      })
    ).toThrow(
      /replaced its state after the last requireUnstarvedFrontier\(\) call, so the bounded output was measured on an ungated frontier/
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
          requireUnstarvedFrontier();
          const replacement = EditorState.create({ doc: view.state.doc, extensions: [markdown()] });
          // The whole discriminating power of this test rests on the doc surviving by
          // IDENTITY, and nothing else here would notice if it stopped: rewriting the line
          // above to `doc: DOC` still replaces the state, so this test stays green while
          // the doc-comparison mutant it exists to kill comes back to life (measured).
          // Asserted inside the fixture rather than as its own `it`, because a separate
          // test would not be coupled to the state this one actually passes to setState.
          expect(replacement.doc).toBe(view.state.doc);
          // The other half of the same dependency: this fixture only kills the
          // dispatch-interception mutant because setState does NOT dispatch. If that ever
          // changed, the state would still be replaced, this test would still pass, and
          // that mutant would quietly survive again.
          let dispatches = 0;
          const realDispatch = view.dispatch.bind(view);
          view.dispatch = ((...args: Parameters<typeof realDispatch>) => {
            dispatches++;
            return realDispatch(...args);
          }) as typeof view.dispatch;
          view.setState(replacement);
          expect(dispatches).toBe(0);
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
    // The refusal compares state IDENTITY, so it must not fire on the five call sites,
    // which all read `view.state` (and settle a separate oracle state) after gating.
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
  // successful-looking observation. `gated` cannot see this — it is set before the throw —
  // so the helper tracks whether the gate actually fired.
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
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/view\.destroy\(\) ALSO threw/);
      expect((errSpy.mock.calls[0]?.[1] as Error).message).toMatch(/widget destroy blew up/);
    } finally {
      errSpy.mockRestore();
    }
    expect(document.body.childElementCount).toBe(before);
  });
});
