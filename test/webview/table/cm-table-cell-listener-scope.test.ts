// @vitest-environment happy-dom
// The lifetime of the listeners `renderCellInto` binds — two per live `<a>`, via
// `attachLinkClickGuard`. Everything here is about WHEN they stop answering,
// which the map/render suites next door never look at.
//
// Why this file exists: `patchRow` re-fills every cell of the table on every
// keystroke that changes its bytes, and each fill binds fresh guards. Handing
// those the widget's element-lifetime signal would pile 2N registrations (each
// retaining a detached anchor through the signal's abort-algorithm list) onto one
// element for the life of that element, so `renderCellInto` cuts a per-fill scope
// chained to the caller's. The two halves that has to satisfy pull in opposite
// directions and are pinned as such below: the PREVIOUS fill's guards must go,
// and the CURRENT fill's must not.
//
// ⚠️ These are listener-registration contracts, not a heap measurement. happy-dom
// is not a faithful oracle for retention; what is pinned here is "who still
// answers", which is observable and is what the retention rests on.
import { beforeEach, describe, expect, it } from "vitest";

import { renderCellInto } from "../../../src/webview/cm/table/cell-render.js";

/** The one gesture the guard answers unconditionally: `auxclick` is
 *  preventDefault'd for every button, because middle-click activation would
 *  otherwise open the href natively and bypass the host's `open-external`
 *  re-validation. `defaultPrevented` therefore reads as "is this anchor's guard
 *  still armed?" with no modifier-key branch in the way. */
function guardArmed(a: HTMLAnchorElement): boolean {
  const event = new MouseEvent("auxclick", { cancelable: true, bubbles: true });
  a.dispatchEvent(event);
  return event.defaultPrevented;
}

function anchorIn(cell: HTMLElement): HTMLAnchorElement {
  const a = cell.querySelector("a");
  expect(a, "fixture must render a live <a>").not.toBeNull();
  return a as HTMLAnchorElement;
}

/** Count what `signal` is holding. A registration has no other observable —
 *  nothing reads back an event target's listener list — and happy-dom routes
 *  signal-driven removal through `removeEventListener`, so the live count is the
 *  difference. */
function countSignalRegistrations(signal: AbortSignal): { added: number; removed: number } {
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<typeof add>) => {
    counts.added++;
    return add(...args);
  };
  signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    counts.removed++;
    return remove(...args);
  };
  return counts;
}

/** A cell IN the document — `isConnected` below is the thing separating "the
 *  previous fill's anchor" from "the current one", and it reads false for every
 *  node in a detached fixture, which would make that distinction vacuous. */
function cellInDocument(): HTMLElement {
  const cell = document.createElement("td");
  document.body.appendChild(cell);
  return cell;
}

describe("renderCellInto listener scope", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("disarms the guards of the fill it replaces", () => {
    const outer = new AbortController();
    const cell = cellInDocument();
    renderCellInto(cell, "[one](https://example.com/1)", "", outer.signal);
    const first = anchorIn(cell);
    expect(guardArmed(first)).toBe(true);

    renderCellInto(cell, "[two](https://example.com/2)", "", outer.signal);

    // `first` is detached now, but a live registration would still answer for it
    // — and would still be holding it. This is the retention, made observable.
    expect(first.isConnected).toBe(false);
    expect(guardArmed(first)).toBe(false);
  });

  it("leaves the current fill's guards armed", () => {
    // The other direction, and the reason the scope is cut here rather than per
    // patch in widget-base.ts: a positional-shift patch re-stamps offsets without
    // re-filling, so anything that disarmed on every patch would disarm links the
    // user can still click.
    const outer = new AbortController();
    const cell = cellInDocument();
    renderCellInto(cell, "[one](https://example.com/1)", "", outer.signal);
    renderCellInto(cell, "[two](https://example.com/2)", "", outer.signal);

    const current = anchorIn(cell);
    expect(current.isConnected).toBe(true);
    expect(guardArmed(current)).toBe(true);
  });

  it("still dies with the caller's scope", () => {
    const outer = new AbortController();
    const cell = cellInDocument();
    renderCellInto(cell, "[one](https://example.com/1)", "", outer.signal);
    const a = anchorIn(cell);

    outer.abort(); // what `QuollWidget.destroy` / a failed patch does

    expect(guardArmed(a)).toBe(false);
  });

  it("keeps a fill's guards armed when the caller's scope is already gone", () => {
    // FAIL-CLOSED, and deliberately so: `cellFillSignal` has NO `outer.aborted`
    // branch. `abort` is one-shot, so a forwarder registered on an
    // already-aborted `outer` simply never runs and the fill's child scope stays
    // LIVE. The alternative — aborting the child up front so the fill "starts
    // disarmed" — binds no guard while `renderCellSafely` still assigns `a.href`
    // and appends the anchor: a live link with the middle-click choke point on
    // `attachLinkClickGuard` removed. Blocked navigation is the safe failure; an
    // unguarded `<a>` is not.
    //
    // ⚠️ "Blocked navigation" covers TWO gestures, not three — the same
    // qualification cell-render.ts carries beside the missing branch, kept here so
    // the pair cannot drift. The cell guard preventDefaults plain click and every
    // `auxclick` itself, but Cmd/Ctrl+click on an absolute href is deliberately
    // left un-preventDefault'd for the widget-root listener
    // (table-widget.ts:754) to route through `quollOpenExternalSink` — and that
    // listener rides the render signal, i.e. the very `outer` this case has
    // already aborted. Not reachable from production (nothing hands
    // `renderCellInto` an aborted signal), which is why it is documented on both
    // sides instead of closed here.
    //
    // ⚠️ TWO assertions, because only the second can tell the two
    // implementations apart in this environment. happy-dom does not implement
    // "an already-aborted signal binds nothing" (measured), so `guardArmed`
    // reads true under the fail-OPEN version too — the first assertion states
    // the contract without discriminating. What discriminates is the NEXT fill:
    // a live child scope is abortable, so the replaced anchor goes quiet. Under
    // the fail-open version that child was aborted BEFORE its guards bound, so
    // the later `abort()` is a no-op and the detached anchor stays armed for the
    // life of the element — the leak this file exists to pin, arriving by the
    // one path that also looked safe.
    const outer = new AbortController();
    outer.abort();
    const cell = cellInDocument();

    renderCellInto(cell, "[one](https://example.com/1)", "", outer.signal);
    const first = anchorIn(cell);
    expect(guardArmed(first)).toBe(true);

    renderCellInto(cell, "[two](https://example.com/2)", "", outer.signal);

    expect(first.isConnected).toBe(false);
    expect(guardArmed(first)).toBe(false);
    expect(guardArmed(anchorIn(cell))).toBe(true);
  });

  it("holds one registration on the caller's scope however many fills run", () => {
    // The bound itself. Without deregistering the forwarder, the caller's signal
    // accumulates one per fill — the same unbounded growth in a new place, just
    // one object per cell smaller. Counted through the signal's own
    // add/removeEventListener because a registration has no other observable.
    const outer = new AbortController();
    const counts = countSignalRegistrations(outer.signal);
    const cell = cellInDocument();
    for (let i = 0; i < 4; i++) {
      renderCellInto(cell, `[link ${i}](https://example.com/${i})`, "", outer.signal);
    }

    expect(counts.added).toBe(4); // one forwarder per fill …
    expect(counts.added - counts.removed).toBe(1); // … but only the newest survives
  });
});
