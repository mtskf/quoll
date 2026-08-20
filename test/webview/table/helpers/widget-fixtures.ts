// Fixtures shared by the four `cm-table-widget-*.test.ts` suites. Who shares
// what: `makeWidget` by all four; `stubView` by render, update and caret;
// `mockView` by render and update; `press` / `SRC` by drag and caret; the
// scripted-caret vehicle (`stubViewWithCaret`, whose `mount` is part of the
// closure it returns) and the image cells by drag alone. That last group lives
// here rather than inline in the drag suite because the resolver-scoping rule
// it carries — now ENFORCED by that closure rather than asked for in prose —
// has to have exactly one definition to be enforceable when the next suite
// reaches for it. Not a test file itself (no `.test.ts` suffix), mirroring
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

// Widgets under test are mounted into the body (the caret resolver needs a live
// tree). Clear it between tests so no test can see an earlier test's widget —
// a mechanism, rather than each test remembering to tidy up. Registered HERE,
// on import, so a suite cannot acquire the mounting vehicle without also
// acquiring the cleanup that makes its mounts safe.
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
// Out-of-band failure channel for the scripted caret resolver. It cannot
// signal by THROWING: `cellPointAt` wraps every resolver call in a catch-all (a
// documented part of the `CaretResolver` contract — a throw must never take
// down the click handler), and `dragRange` turns a null point into the
// collapsed caret. So a resolver that failed for a reason the test did not ASK
// for is indistinguishable, at the assertion, from one scripted to return null
// on purpose — and the caret is the expected value of most rows in the drag
// suite, so the failure reads as a pass. Recording the reason here and throwing
// it below is the only channel that survives the catch-all.
//
// Attribution rests on one invariant: the mousedown/click handlers in
// table-widget.ts call the resolver SYNCHRONOUSLY (no rAF, timeout or promise
// anywhere on that path) and no suite here has an async test body, so every
// failure is recorded before the owning test returns — i.e. before its own
// `afterEach` runs. Should that path ever go async, a failure would drain into
// the NEXT test's hook and be reported against an innocent row; move the drain
// to `onTestFinished` registered per vehicle if that day comes.
const resolverFailures: string[] = [];

afterEach(() => {
  // Cleanup FIRST, so a throwing drain never also leaks DOM into the next test.
  document.body.replaceChildren();
  if (resolverFailures.length > 0) {
    const reasons = resolverFailures.join("; ");
    resolverFailures.length = 0; // drain BEFORE throwing, or the next test inherits it
    throw new Error(`scripted caret resolver misuse: ${reasons}`);
  }
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
 *  reads work; no doc/extensions beyond the optional resource base).
 *
 *  `dispatched` is REQUIRED, not optional. Omitted, the recorder silently
 *  no-opped — and four render rows assert `expect(dispatched).toEqual([])`,
 *  which a recorder that records NOTHING satisfies for free. Passing `[]`
 *  explicitly costs two characters and makes those four rows mean something.
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
  } satisfies Pick<EditorViewType, "state" | "dispatch"> as unknown as EditorViewType;
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
 *  VACUOUSLY rather than fail. */
export function stubViewWithCaret(
  dispatched: unknown[],
  script: Array<{ text: string; offset: number } | null>,
  extensions: Extension[] = []
): { view: EditorViewType; mount: (widget: TableBlockWidget) => HTMLElement } {
  let root: HTMLElement | null = null;
  let i = 0;
  const resolve: CaretResolver = () => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step === null) {
      return null; // the one INTENTIONAL no-mapping — silence is correct here
    }
    if (step === undefined) {
      resolverFailures.push("resolver called with an EMPTY script — nothing to aim at");
      return null;
    }
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
  const view = {
    state: EditorState.create({ extensions: [quollTableCaretResolver.of(resolve), ...extensions] }),
    dispatch: (tr: unknown) => dispatched.push(tr),
  } satisfies Pick<EditorViewType, "state" | "dispatch"> as unknown as EditorViewType;

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
    return dom;
  };
  return { view, mount };
}

/** Dispatch a mouse event carrying coordinates — the movement threshold reads
 *  them, and happy-dom defaults them to 0. `detail: 1` by default because a
 *  real pointer click always carries a click count; `detail: 0` is reserved for
 *  keyboard/programmatic activation, which the drag path deliberately ignores
 *  (override it explicitly to exercise that guard). */
export function press(
  el: HTMLElement,
  type: "mousedown" | "click",
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
