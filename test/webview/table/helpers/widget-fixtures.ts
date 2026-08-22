// Fixtures shared by the five `cm-table-widget-*.test.ts` suites (render,
// update, caret, drag, release) and by widget-fixtures-guards.test.ts, the
// probe file that pins this module's own mechanisms. Who shares what:
// `makeWidget` by all six; `stubView` by render, update and caret; `mockView`
// by render, update and guards; `press` / `SRC` by drag, release, caret and
// guards; the scripted-caret vehicle (`stubViewWithCaret`, whose `mount` /
// `update` / `scrollContentBy` are part of the closure it returns) by drag,
// release and guards — `scrollContentBy` by drag alone and the `posAtCoords`
// script by release alone; `drainResolverFailures` by guards alone; `IMG_CELL`
// by drag AND release, `MIXED_IMG_CELL` by drag alone. The vehicle lives here
// rather than inline in the drag suite because the resolver-scoping rule it
// carries — now ENFORCED by that closure rather than asked for in prose — has
// to have exactly one definition to be enforceable when the next suite reaches
// for it. Not a test file itself (no `.test.ts` suffix), mirroring
// test/webview-browser/helpers/frames.ts.
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { afterEach } from "vitest";

import { parseTable } from "../../../../src/markdown/table/index.js";
import { quollResourceBaseUri } from "../../../../src/webview/cm/image/resource-base.js";
import { quollOpenExternalSink } from "../../../../src/webview/cm/open-external.js";
import {
  type CaretResolver,
  quollTableCaretResolver,
} from "../../../../src/webview/cm/table/cell-point.js";
import { TableBlockWidget } from "../../../../src/webview/cm/table/table-widget.js";

// Out-of-band failure channel for this module's own misuse reports. Its first
// producer was the scripted caret resolver — hence the name it and its drain
// still carry — but the widget-disposer loop in the `afterEach` below reports
// through it too, so the message each producer pushes has to name its own
// mechanism; the headline the drain prints cannot.
//
// The resolver cannot signal by THROWING: `cellPointAt` wraps every resolver
// call in a catch-all (a documented part of the `CaretResolver` contract — a
// throw must never take down the click handler), and `dragRange` turns a null
// point into the collapsed caret. So a resolver that failed for a reason the
// test did not ASK for is indistinguishable, at the assertion, from one
// scripted to return null on purpose — and the caret is the expected value of
// most rows in the drag suite, so the failure reads as a pass. Recording the
// reason here and throwing it out of the drain below is the only channel that
// survives the catch-all.
const resolverFailures: string[] = [];

/** Throw whatever this module's producers recorded since the last drain, and
 *  clear it either way. The `afterEach` below is the automatic caller — every
 *  suite gets the channel for free — and it is EXPORTED so the guards probe can
 *  assert on a deliberately-provoked failure in-test: an expected failure has to
 *  be consumed inside the case that provoked it, or the hook would rethrow it
 *  and redden a test that behaved exactly as designed.
 *
 *  Attribution rests on one invariant: the mousedown/click handlers in
 *  table-widget.ts call the resolver SYNCHRONOUSLY (no rAF, timeout or promise
 *  anywhere on that path) and no suite here has an async test body, so every
 *  failure is recorded before the owning test returns — i.e. before its own
 *  `afterEach` runs. Should that path ever go async, a failure would drain into
 *  the NEXT test's hook and be reported against an innocent row; move the drain
 *  to `onTestFinished` registered per vehicle if that day comes. */
export function drainResolverFailures(): void {
  // `splice` empties the channel before there is anything to throw, so the
  // throw cannot leave entries behind for the next test to inherit.
  const reasons = resolverFailures.splice(0);
  if (reasons.length > 0) {
    // A MECHANISM-NEUTRAL headline: the channel has more than one producer, and
    // leading with any one of their names would misattribute the others. Each
    // reason names its own mechanism instead. Newline-joined rather than
    // `"; "`-joined because a reason may itself be multi-line — a disposer
    // reason carries the thrown error's stack.
    throw new Error(`widget fixture misuse:\n${reasons.join("\n")}`);
  }
}

// Disposers for widgets mounted through `stubViewWithCaret`. A widget owns
// DOCUMENT-level listeners while a gesture is in flight, and `replaceChildren`
// only unparents its DOM — `destroy` is what CodeMirror itself would call, and
// what actually takes those listeners with it.
//
// The leak this prevents is per-GESTURE, not per-file: the listeners are armed
// on `mousedown` and removed only when the gesture's controller aborts, so
// every row whose release the seam never saw — every click-seam row, every
// mousedown-only row — would leave its own listener set on the document for
// the rest of the file, not merely the last mount's.
const mountedWidgets: Array<() => void> = [];

// Widgets under test are mounted into the body (the caret resolver needs a live
// tree). Clear it between tests so no test can see an earlier test's widget —
// a mechanism, rather than each test remembering to tidy up. Registered HERE,
// on import, so a suite cannot acquire the mounting vehicle without also
// acquiring the cleanup that makes its mounts safe, nor the resolver without
// the drain that makes its silent failures audible.
//
// ⚠️ One limit on that guarantee, measured. It holds only under vitest's
// default `isolate: true`, where this module is re-evaluated per test file:
// under `--isolate=false` the module is evaluated once and the hook attaches to
// the FIRST importing suite alone. The hook IS pinned — widget-fixtures-guards
// .test.ts holds an order-dependent probe pair that reddens when it is removed,
// and reddens under `--isolate=false` too, which is the accurate signal rather
// than a spurious one. (Before that probe, deleting this hook left all 78 tests
// green: cross-widget capture is prevented by the resolver's private root, not
// by body cleanliness, so nothing observed the body between cases.)
afterEach(() => {
  // Cleanup FIRST, so a throwing drain never also leaks DOM into the next test.
  // Destroy BEFORE unparenting: the widget's own teardown is what removes the
  // document listeners, and it must not depend on the DOM still being attached.
  //
  // Per-disposer catch, not a bare loop. No disposer can throw TODAY —
  // `destroy` only calls `AbortController.abort()`, and nothing registers an
  // `abort` listener on that signal, so no user code runs during teardown — but
  // this loop is a throw-CAPABLE step sitting ahead of the two cleanups the
  // comment above orders first, and the failure mode is silent three ways at
  // once: the remaining disposers are skipped (leaking the very document
  // listeners this loop exists to remove), `replaceChildren` is skipped, and
  // the drain is skipped, pushing a recorded resolver failure into the NEXT
  // test's hook — the misattribution `drainResolverFailures`' docblock is built
  // to prevent. Routing a throw into `resolverFailures` keeps the report on the
  // test that provoked it and keeps the ordering invariant structural rather
  // than dependent on `destroy` staying throw-free.
  for (const dispose of mountedWidgets.splice(0)) {
    try {
      dispose();
    } catch (err) {
      // The STACK, not `String(err)`. The drain throws a NEW Error, whose own
      // stack points at this hook, so unless the thrown one is carried in the
      // message nothing anywhere names the throw site — and this loop calls
      // into `TableBlockWidget.destroy`, a mechanism the reason has to name
      // itself because the drain's headline is deliberately neutral.
      resolverFailures.push(
        `widget disposer threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
    }
  }
  document.body.replaceChildren();
  drainResolverFailures();
});

export function makeWidget(src: string, docFrom = 0): TableBlockWidget {
  const table = parseTable(src, 0, src.length);
  if (table === null) {
    throw new Error("fixture must parse");
  }
  return new TableBlockWidget(table, src, docFrom, 0);
}

/** Minimal view stub — display-only toDOM reads `view.dispatch` and
 *  `view.state.facet(quollResourceBaseUri)` (a real EditorState so facet
 *  reads work; the doc is empty and the only extensions are the two optional
 *  ones below: the resource base, and the `quollOpenExternalSink` that
 *  `opened` installs to capture what a widget-internal link would open).
 *
 *  `dispatched` is REQUIRED, not optional. Left optional, a call site that
 *  omits it gets a recorder that silently no-ops — and a no-op recorder is
 *  indistinguishable from a widget that dispatched nothing, so the day someone
 *  adds `expect(dispatched).toEqual([...])` to one of those call sites it can
 *  go vacuously green against an array nothing was ever written to. Requiring
 *  the argument costs two characters and keeps every stub's recorder real.
 *
 *  `satisfies` before the cast: `as unknown as EditorViewType` erases the
 *  literal's own shape, so a `dispath` typo would compile and every dispatch
 *  assertion in three suites would silently go empty. The clause type-checks
 *  the literal against the real surface first (verified non-vacuous: the typo
 *  reddens with TS2561), and the cast then covers only the members a
 *  display-only widget never touches. */
export function stubView(
  dispatched: unknown[],
  resourceBase?: string,
  opened?: string[]
): EditorViewType {
  const extensions = [];
  if (resourceBase !== undefined) {
    extensions.push(quollResourceBaseUri.of(resourceBase));
  }
  if (opened !== undefined) {
    extensions.push(quollOpenExternalSink.of((href: string) => opened.push(href)));
  }
  return {
    state: EditorState.create({ extensions }),
    dispatch: (tr: unknown) => dispatched.push(tr),
    // The widget measures pointer travel against this element's rect when it
    // arms a gesture, so a stub without one throws inside a DOM listener —
    // where the throw is swallowed and the test sees a missing dispatch rather
    // than an error. happy-dom reports an all-zero rect, which is exactly right
    // for the suites using this stub: content that never moves.
    contentDOM: document.createElement("div"),
  } satisfies Pick<
    EditorViewType,
    "state" | "dispatch" | "contentDOM"
  > as unknown as EditorViewType;
}

/** The shared throwaway-recorder `stubView` — for the display-only paths, where
 *  no test asserts on what was dispatched. */
export const mockView = stubView([]);

/** A view stub whose caret resolver is scripted: successive calls return the
 *  successive scripted positions, so a mousedown/click pair can be aimed at two
 *  different characters without a layout engine.
 *
 *  The vehicle is returned as a CLOSURE PAIR — `view` plus the `mount` that
 *  feeds it — because the two are only meaningful together. The lookup root is
 *  module-private and assigned by `mount` alone, so a widget mounted through
 *  one vehicle can never be resolved against another's: mis-pairing is not
 *  representable, rather than being a rule a doc comment asks tests to keep.
 *  It has to be structural, because a body-wide or cross-vehicle lookup could
 *  find a DIFFERENT widget's identically-texted cell, `root.contains` would
 *  reject it, and the drag would silently degrade to the caret path — the
 *  EXPECTED value of most rows in the drag suite, so the mistake would pass
 *  VACUOUSLY rather than fail.
 *
 *  `view` itself is deliberately NOT returned. While it was, the guard below
 *  was reachable around: `makeWidget(src).toDOM(view)` renders a second widget
 *  through this vehicle without going through `mount`, leaving the resolver
 *  pointed at the FIRST widget's tree. That walk then SUCCEEDS — most rows
 *  share `SRC`, so the text is found in the wrong widget — and a successful
 *  walk trips none of the failure arms above. `cellPointAt`'s containment gate
 *  (`!root.contains(cell)`, cell-point.ts) rejects the foreign node a moment
 *  later and the gesture degrades to the collapsed caret: the EXPECTED value of
 *  most rows in the drag suite, so the mis-pair reads as a pass and nothing
 *  anywhere records that it happened. `update` exists so the two rows
 *  that call `updateDOM` still can, without the view escaping to do it. */
export function stubViewWithCaret(
  dispatched: unknown[],
  script: Array<{ text: string; offset: number } | null>,
  extensions: Extension[] = [],
  /** What `view.posAtCoords` answers for a release point OUTSIDE the widget —
   *  the document position the outside-release seam uses as the range head.
   *  Scripted per suite, like the caret resolver, because happy-dom has no
   *  layout and CodeMirror is not mounted here at all.
   *
   *  The default is NOT `() => null`: a null answer degrades to the collapsed
   *  caret, which is the expected value of several rows in the release suite, so
   *  an unscripted call would pass vacuously. It records misuse through the same
   *  channel the caret resolver uses, so an unscripted call is audible instead. */
  posAtCoords?: (x: number, y: number) => number | null
) {
  let root: HTMLElement | null = null;
  let i = 0;
  const resolve: CaretResolver = () => {
    // NOT clamped to the last step. Replaying the final step for an
    // off-the-end call would answer a gesture the script never described with
    // a plausible-looking position, and a plausible answer trips none of the
    // failure arms below — the row would pass while testing something nobody
    // wrote down. Running off the end reads `undefined` instead, which is a
    // recorded failure. (Measured: no drag row needs the clamp.)
    const step = script[i++];
    if (step === null) {
      return null; // the one INTENTIONAL no-mapping — silence is correct here
    }
    if (step === undefined) {
      resolverFailures.push(
        script.length === 0
          ? "resolver called with an EMPTY script — nothing to aim at"
          : `resolver call #${i} ran off the end of a ${script.length}-step script`
      );
      return null;
    }
    // A TYPED GUARD, not a detector — and deliberately not pinned. It is
    // UNREACHABLE by construction: `view` never leaves this closure, so `mount`
    // is the only thing that can render a widget onto this resolver, and it
    // assigns `root` before returning. (It WAS reachable while `view` escaped —
    // `makeWidget(SRC).toDOM(view)` renders without mounting — which is what
    // the recorded message describes.) No probe is written for it, because a
    // probe that cannot fail is the vacuity this file exists to remove.
    // It stays because `root` is `HTMLElement | null` and `createTreeWalker`
    // needs the narrowing: deleting it buys a non-null assertion, trading a
    // loud typed guard for a silent one.
    if (root === null) {
      resolverFailures.push(`resolver ran before mount (looking for ${JSON.stringify(step.text)})`);
      return null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n.textContent === step.text) {
        return { node: n, offset: step.offset };
      }
    }
    resolverFailures.push(
      `scripted text ${JSON.stringify(step.text)} matched no text node in the mounted widget`
    );
    return null;
  };
  // happy-dom has no layout engine, so `getBoundingClientRect` answers zeros for
  // everything. The widget only ever reads `left`/`top` off this rect, so a
  // scripted origin is a complete stand-in — and it is the ONLY way to express
  // "the content moved under a stationary pointer" without a layout engine.
  const contentDOM = document.createElement("div");
  let origin = { left: 0, top: 0 };
  contentDOM.getBoundingClientRect = () =>
    ({
      ...origin,
      x: origin.left,
      y: origin.top,
      width: 0,
      height: 0,
      right: 0,
      bottom: 0,
    }) as DOMRect;

  const view = {
    state: EditorState.create({ extensions: [quollTableCaretResolver.of(resolve), ...extensions] }),
    dispatch: (tr: unknown) => dispatched.push(tr),
    contentDOM,
    // ⚠️ `EditorView.posAtCoords` is OVERLOADED — `(coords, precise: false):
    // number` and `(coords): number | null` — and a single-signature stub is not
    // assignable to the FIRST overload, so `satisfies` rejects it with TS2322
    // ("Type 'number | null' is not assignable to type 'number'"). Measured with
    // tsc, and worth knowing WHY this cast is here rather than "cleaning it up":
    // vitest is transpile-only, so no test run would catch its removal — the
    // error surfaces only at `pnpm compile`.
    //
    // Only this ONE member is cast, and the key stays IN the `Pick` below, so an
    // omitted member is still an error. Casting the whole literal instead would
    // give up the typo check (`dispath`) for every member at once, which is the
    // entire reason the `satisfies` clause exists.
    posAtCoords: ((coords: { x: number; y: number }) => {
      if (posAtCoords === undefined) {
        resolverFailures.push("view.posAtCoords called with no scripted answer");
        return null;
      }
      return posAtCoords(coords.x, coords.y);
    }) as EditorViewType["posAtCoords"],
  } satisfies Pick<
    EditorViewType,
    "state" | "dispatch" | "contentDOM" | "posAtCoords"
  > as unknown as EditorViewType;

  /** Mount a widget the way every drag test needs it: rendered, resolver root
   *  wired, attached to the body (the caret resolver needs a live tree). The
   *  root assignment is the whole point — done by hand it is a line a new test
   *  can forget, and forgetting it degrades that test to the caret path where
   *  it may still pass VACUOUSLY.
   *
   *  ONE VEHICLE, ONE WIDGET. A second `mount` would overwrite `root`, orphan
   *  the first widget in the body, and re-point the resolver at the second
   *  tree — and because most rows here share `SRC`, the scripted text usually
   *  EXISTS in both, so the walker would find a plausible match in the wrong
   *  widget and dispatch a wrong-but-believable offset. That outcome is not a
   *  miss, so none of the failure arms above would catch it. Refusing the
   *  second mount is what keeps it out of reach — the closure would otherwise
   *  close one misuse channel while leaving this one open. */
  const mount = (widget: TableBlockWidget): HTMLElement => {
    if (root !== null) {
      throw new Error(
        "mount() called twice on one stubViewWithCaret vehicle — build a new vehicle per widget"
      );
    }
    const dom = widget.toDOM(view);
    root = dom;
    document.body.appendChild(dom);
    mountedWidgets.push(() => widget.destroy(dom));
    return dom;
  };

  /** `updateDOM` through the vehicle's own view — the only other consumer of
   *  `view`, and the reason `view` itself never escapes. */
  const update = (dom: HTMLElement, next: TableBlockWidget, prev: TableBlockWidget): boolean =>
    next.updateDOM(dom, view, prev);

  /** Move the CONTENT by (dx, dy) — a scroll, a `scrollIntoView` from the host,
   *  anything that shifts the text under a held pointer. Scrolling DOWN by 40
   *  moves the content UP, so the origin goes negative: a pointer that has not
   *  moved is then 40px further into the document than where it pressed, which
   *  is the travel the old viewport measurement could not see. */
  const scrollContentBy = (dx: number, dy: number): void => {
    origin = { left: origin.left - dx, top: origin.top - dy };
  };

  return { mount, update, scrollContentBy };
}

/** Dispatch a mouse event carrying coordinates — the movement threshold reads
 *  them, and happy-dom defaults them to 0. `detail: 1` by default because a
 *  real pointer click always carries a click count; `detail: 0` is reserved for
 *  keyboard/programmatic activation, which the drag path deliberately ignores
 *  (override it explicitly to exercise that guard).
 *
 *  `mouseup` is what the OUTSIDE-release seam listens for, and it is dispatched
 *  on whatever element the pointer was released over — usually NOT the widget,
 *  which is the whole point of that seam. Aim it at `document.body` to model a
 *  release that landed outside the table. */
export function press(
  el: HTMLElement,
  type: "mousedown" | "mouseup" | "click",
  x: number,
  y: number,
  init: MouseEventInit = {}
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    detail: 1,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

export const SRC = "| Name | Role |\n| - | - |\n| alpha | admin |";

/** A cell whose render contains a LIVE image — the only construct that renders
 *  no text, and therefore the only remaining source of "no exact mapping".
 *  The `https:` src is not decoration: `resolveAgainstBase` returns null for a
 *  relative src with an empty base, which would render the image INERT (whole
 *  source slice as text) and quietly make every case that uses it mappable. The `a`
 *  and `b` around it exist so a scripted resolver has a text node to aim at;
 *  the junction between them is the unmappable boundary. */
export const IMG_CELL = "a![i](https://x.test/a.png)b";

/** The same live image with MULTI-character text on both sides, so a scripted
 *  resolver can aim at a boundary strictly INSIDE a text run — an exact offset
 *  — and pair it with the junction beside the image, which is unmappable. With
 *  `IMG_CELL`'s single `a`/`b` every mappable boundary is already a cell edge,
 *  so a mixed-mappability drag there is indistinguishable from the whole-cell
 *  snap it must produce. Runs (measured): `[{0,0,3,0,3},{3,29,32,29,32}]` over
 *  rendered `abcdef`, so rendered 3 is the junction and 4/5 are exact. */
export const MIXED_IMG_CELL = "abc![i](https://x.test/a.png)def";
