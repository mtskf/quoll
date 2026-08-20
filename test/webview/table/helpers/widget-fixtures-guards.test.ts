// @vitest-environment happy-dom
// Probes for the fixture module's own guarantees — the ones no behaviour test
// observes, and which therefore stay green when the mechanism is deleted.
import { describe, expect, it } from "vitest";

import {
  drainResolverFailures,
  makeWidget,
  mockView,
  press,
  SRC,
  stubViewWithCaret,
} from "./widget-fixtures.js";

// The pair is ORDER-DEPENDENT by design: the first case dirties the body, the
// second asserts the import-time `afterEach` in widget-fixtures.ts cleaned it.
// Delete that hook and the second case reddens. It also reddens under
// `--isolate=false` when this file is not the FIRST importer of the module —
// which is correct rather than spurious: under that flag the module is
// evaluated once and the hook attaches to the first importing suite alone, so
// body cleanup genuinely is not in effect here. The probe turns that silent
// degradation into a visible failure.
//
// `armed` is why the second case cannot go vacuous. Running it ALONE — `-t
// "empty body"`, or an `.only` while iterating on the very hook it pins —
// skips the case that dirties the body, so an empty body would prove nothing
// and pass anyway. That is the exact failure mode this file exists to
// eliminate, so it gets a mechanism rather than a warning comment: the flag
// makes an isolated run RED, with a message saying why.
//
// Holding the order takes BOTH options, not just the first. `sequential` only
// forbids the two cases from running CONCURRENTLY; the order they are queued
// in is decided separately, and a suite inherits `sequence.shuffle` from
// vitest.config.ts or the CLI regardless of its concurrency mode. Measured on
// vitest 4.1.10 under `--sequence.shuffle`: with `sequential` alone this pair
// failed 3 of 8 runs in one sample and 1 of 8 in another; with
// `{ shuffle: false }` it passed 8 of 8. The options object is the SECOND
// argument in vitest 4 — passed third, `parseArguments` throws.
let armed = false;

describe.sequential("widget-fixtures body cleanup", { shuffle: false }, () => {
  it("leaves a mounted widget in the body (arming the probe below)", () => {
    document.body.appendChild(makeWidget(SRC).toDOM(mockView));
    expect(document.body.children.length).toBe(1);
    armed = true;
  });

  it("starts with an empty body — the import-time afterEach cleaned up", () => {
    expect(
      armed,
      "the arming case did not run — this probe is vacuous when filtered; run the whole file"
    ).toBe(true);
    expect(document.body.children.length).toBe(0);
  });
});

// The scripted-caret vehicle's own refusals. A SEPARATE describe on purpose:
// the pair above is order-dependent, and dropping unrelated cases between its
// two halves would put another suite's DOM and another suite's `afterEach`
// between the arming and the assertion.
//
// ⚠️ Firing the resolver takes a real gesture. `cellPointAt` runs it once from
// `mousedown` and once more from `click`, but only for a click that carries
// `detail !== 0` AND travelled at least DRAG_THRESHOLD_PX (4) from the press —
// so a lone `click`, or a click at the press coordinates, resolves NOTHING and
// any probe built on one passes vacuously. Every case below uses a mousedown /
// far-click pair.
//
// The recorded failures are consumed HERE, in the case that provoked them,
// rather than left for the module's `afterEach`: an expected failure reaching
// that hook would redden the very test that proved the channel works.
describe("stubViewWithCaret misuse guards", () => {
  it("refuses a second mount on one vehicle", () => {
    const { mount } = stubViewWithCaret([], [{ text: "alpha", offset: 0 }]);
    mount(makeWidget(SRC));
    expect(() => mount(makeWidget(SRC))).toThrow(/called twice/);
  });

  it("records a scripted text that matches no text node in the mounted widget", () => {
    const { mount } = stubViewWithCaret(
      [],
      [
        { text: "nowhere", offset: 0 },
        { text: "nowhere", offset: 1 },
      ]
    );
    const td = mount(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    expect(() => drainResolverFailures()).toThrow(/matched no text node/);
  });

  // No call site reaches this arm today, which is exactly why it is pinned: an
  // arm nothing exercises is the one that rots without anyone noticing.
  it("records a resolver call made against an EMPTY script", () => {
    const { mount } = stubViewWithCaret([], []);
    const td = mount(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    expect(() => drainResolverFailures()).toThrow(/EMPTY script/);
  });

  // Pins the ABSENCE of a last-step clamp: with one, the click would replay the
  // mousedown's step, resolve successfully, and record nothing at all.
  it("records a gesture that runs off the end of its script", () => {
    const { mount } = stubViewWithCaret([], [{ text: "alpha", offset: 1 }]);
    const td = mount(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    expect(() => drainResolverFailures()).toThrow(/ran off the end of a 1-step script/);
  });
});
