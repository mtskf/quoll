// Fixtures shared by the four `cm-table-widget-*.test.ts` suites. What is
// shared by whom: `makeWidget` / `stubView` / `mockView` by render, update and
// caret; `press` / `SRC` by drag and caret; the scripted-caret vehicle
// (`stubViewWithCaret` + `mountWidget`) by drag alone. That last pair lives
// here anyway rather than inline in the drag suite, because `mountWidget`'s
// `scope.root` assignment is what keeps a drag test from silently degrading to
// the caret path and passing VACUOUSLY — a rule that has to have exactly one
// definition to be enforceable when the next suite reaches for it. Not a test
// file itself (no `.test.ts` suffix), mirroring
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
// on import, so a suite cannot acquire `mountWidget` without also acquiring the
// cleanup that makes its mounts safe.
//
// ⚠️ Two limits on that guarantee, both measured. It holds only under vitest's
// default `isolate: true`, where this module is re-evaluated per test file:
// under `--isolate=false` the module is evaluated once and the hook attaches to
// the FIRST importing suite alone. And nothing currently pins it — no test
// asserts on `document.body` between cases, so deleting this hook leaves all 78
// green (cross-widget capture is prevented by `scope.root` scoping, not by body
// cleanliness). A probe pair that reddens when the hook is removed is a
// follow-up entry in docs/TODO.md.
afterEach(() => {
  document.body.replaceChildren();
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
 *  reads work; no doc/extensions beyond the optional resource base). */
export function stubView(
  dispatched?: unknown[],
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
    dispatch: (tr: unknown) => dispatched?.push(tr),
  } as unknown as EditorViewType;
}

/** A view stub that records nothing — for the display-only paths, where the
 *  dispatch is never read. */
export const mockView = stubView();

/** A view stub whose caret resolver is scripted: successive calls return the
 *  successive scripted positions, so a mousedown/click pair can be aimed at two
 *  different characters without a layout engine.
 *
 *  The lookup is scoped to `scope.root` — the widget under test — NOT to
 *  `document.body`. A body-wide search could find a DIFFERENT widget's
 *  identically-texted cell, `root.contains` would reject it, and the drag would
 *  silently degrade to the caret path. That would not merely fail a test — it
 *  would make the "updateDOM cancels an in-flight drag" case pass VACUOUSLY
 *  (its anchor would already be null for the wrong reason). Mount through
 *  `mountWidget`, which owns the `scope.root` assignment. */
export function stubViewWithCaret(
  dispatched: unknown[],
  script: Array<{ text: string; offset: number } | null>,
  extensions: Extension[] = []
): { view: EditorViewType; scope: { root: HTMLElement | null } } {
  const scope: { root: HTMLElement | null } = { root: null };
  let i = 0;
  const resolve: CaretResolver = () => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step === null || scope.root === null) {
      return null;
    }
    const walker = document.createTreeWalker(scope.root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n.textContent === step.text) {
        return { node: n, offset: step.offset };
      }
    }
    return null;
  };
  const view = {
    state: EditorState.create({ extensions: [quollTableCaretResolver.of(resolve), ...extensions] }),
    dispatch: (tr: unknown) => dispatched.push(tr),
  } as unknown as EditorViewType;
  return { view, scope };
}

/** Mount a widget the way every drag test needs it: rendered, `scope.root`
 *  wired, and attached to the body. The `scope.root` assignment is the whole
 *  point — done by hand it is a line a new test can forget, and forgetting it
 *  degrades that test to the caret path where it may still pass VACUOUSLY. */
export function mountWidget(
  widget: TableBlockWidget,
  view: EditorViewType,
  scope: { root: HTMLElement | null }
): HTMLElement {
  const dom = widget.toDOM(view);
  scope.root = dom;
  document.body.appendChild(dom);
  return dom;
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
