// Shared vehicle for the two real-Chromium table-cell drag suites:
// table-drag-selection.browser.test.ts (the trusted-gesture contracts) and
// table-drag-observer.browser.test.ts (the design premise those contracts rest
// on). Not a test file itself (no .browser.test.ts suffix), mirroring
// helpers/handoff-window.ts.
//
// Why a real browser at all: every drag test in test/webview/table/ builds the
// widget by hand — `widget.toDOM(stubView)` on a detached-then-appended <div>,
// with a SCRIPTED CaretResolver — so nothing there observes the facts the
// design actually rests on. happy-dom has no layout engine, so the production
// `defaultCaretResolver` (caretPositionFromPoint / caretRangeFromPoint — memory
// quoll-cm-destroys-widget-dom-selection) returns nothing and a pointer
// coordinate cannot be mapped at all. Until this suite the premise rested on
// one manual Chromium session (LEARNING.md, 2026-08-12).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../src/webview/styles.css";
import type { CaretResolver } from "../../../src/webview/cm/table/cell-point.js";
import { tableBlockField, tableSkeletonField } from "../../../src/webview/cm/table/index.js";
import { quollTheme } from "../../../src/webview/cm/theme.js";

// Row 1's cells are plain text (no inline markup) so `renderedText.length ===
// cellTo - cellFrom` holds and cell-point.ts maps a pointer to an EXACT source
// offset — the byte-aligned arm the offset assertions depend on. Row 2's first
// cell is deliberately NOT byte-aligned (`**bo**`, 6 source bytes, renders as
// 2 characters) so the snap-to-cell-boundary arm is reachable too.
const DOC =
  "# Doc\n\npara\n\n| Alpha | Beta |\n| ----- | ---- |\n| gamma | delta |\n| **bo** | plain |\n\ntail\n";
/** Content-start source offsets — what the widget stamps as `data-cell-from`. */
export const GAMMA = DOC.indexOf("gamma");
export const DELTA = DOC.indexOf("delta");
export const BOLD_FROM = DOC.indexOf("**bo**");
export const PLAIN = DOC.indexOf("plain");
/** Source offset of the table block's first byte — the caret the widget falls
 *  back to when a gesture maps to no cell at all (`blockStartCaret`). */
export const TABLE_BLOCK_START = DOC.indexOf("| Alpha");

/** Drain CM's bounded measure queue (4-frame idiom shared with the sibling
 *  browser suites) so getBoundingClientRect reads a settled layout. */
export function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

/** Production extension order for the table island (editor.ts: skeleton field
 *  BEFORE the block field). Caret parked at doc end so the line-level reveal is
 *  not already firing when a gesture starts. `extra` exists only so a suite can
 *  pin the OTHER caret-from-point arm through `quollTableCaretResolver.of(...)`
 *  — pass nothing and the widget runs on `defaultCaretResolver`, which is what
 *  production does (nothing in src/ provides that facet). */
export function mount(extra: Extension = []): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-table-drag-probe";
  parent.style.width = "600px";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      // DOC has no CRLF, so string length IS Text length.
      selection: EditorSelection.cursor(DOC.length),
      extensions: [
        quollTheme,
        markdown({ base: markdownLanguage }),
        tableSkeletonField,
        tableBlockField,
        extra,
      ],
    }),
    parent,
  });
}

/** Tear down whatever `mount()` put on the page. */
export function unmount(v: EditorView | undefined): void {
  v?.destroy();
  window.getSelection()?.removeAllRanges();
  for (const n of document.body.querySelectorAll(".cm-table-drag-probe")) {
    n.remove();
  }
}

export function widgetRoot(v: EditorView): HTMLElement {
  const root = v.contentDOM.querySelector<HTMLElement>(".quoll-table-block");
  expect(root, "table widget must be rendered").not.toBeNull();
  return root as HTMLElement;
}

export function cellByText(v: EditorView, text: string): HTMLElement {
  const cell = [...widgetRoot(v).querySelectorAll<HTMLElement>("th, td")].find(
    (c) => c.textContent === text
  );
  expect(cell, `cell "${text}" must be rendered`).toBeDefined();
  return cell as HTMLElement;
}

/** First text node in `cell` — a TreeWalker rather than `firstChild` because a
 *  cell holding inline markup wraps its text (`<strong>bo</strong>`). */
export function firstText(cell: HTMLElement): Text {
  const node = cell.ownerDocument
    .createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    .nextNode() as Text | null;
  expect(node, "cell must render at least one text node").not.toBeNull();
  return node as Text;
}

/** An x/y pair. Viewport coordinates — what getBoundingClientRect reports and
 *  what caret-from-point takes — everywhere except `toLocal`'s return, which is
 *  element-local because that is what Playwright's position options take. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** Viewport point sitting in the LEFT QUARTER of character `index`'s box, so
 *  the browser's caret-from-point lands on the boundary BEFORE that character
 *  (a midpoint would be a coin-flip between `index` and `index + 1`).
 *  Measured with a Range because a character has no element of its own. */
export function pointAtChar(cell: HTMLElement, index: number): Point {
  const text = firstText(cell);
  const range = cell.ownerDocument.createRange();
  range.setStart(text, index);
  range.setEnd(text, index + 1);
  const box = range.getBoundingClientRect();
  expect(box.width, "character box must have real width (layout engine present)").toBeGreaterThan(
    2
  );
  return { x: box.left + box.width * 0.25, y: box.top + box.height / 2 };
}

/** Viewport point inside the widget root's own BOTTOM PADDING — inside `root`'s
 *  box, below the `<table>`, on no `th`/`td` at all. `.quoll-table-block` pads
 *  vertically only (`padding: var(--quoll-table-block-pad) 0`, styles.css), so
 *  the horizontal edges are transparent border, not padding — the reachable
 *  cell-free region is above and below the table. Asserted, not assumed: a
 *  padding change that swallowed this point would otherwise turn the test into
 *  a second cell-release test in silence. */
export function pointInWidgetPadding(root: HTMLElement): Point {
  const box = root.getBoundingClientRect();
  const pt = { x: box.left + box.width / 2, y: box.bottom - 2 };
  const hit = root.ownerDocument.elementFromPoint(pt.x, pt.y);
  expect(hit, "a point must sit in the widget's own padding").toBe(root);
  expect(hit?.closest("th, td"), "and it must be on no cell").toBeNull();
  return pt;
}

/** Playwright positions a pointer action relative to the element's PADDING BOX
 *  top-left, while getBoundingClientRect measures the border box — hence the
 *  explicit border subtraction rather than a bare `pt.x - box.left`. */
function toLocal(el: HTMLElement, pt: Point): Point {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    x: pt.x - box.left - Number.parseFloat(style.borderLeftWidth),
    y: pt.y - box.top - Number.parseFloat(style.borderTopWidth),
  };
}

/** Pointer positions the two adapters below hand to Playwright.
 *
 *  ⚠️ vitest declares `UserEventDragAndDropOptions` / `UserEventClickOptions` as
 *  EMPTY interfaces and lets the active provider augment them; the augmentation
 *  lives in `@vitest/browser-playwright`, which this suite's tsconfig program
 *  never pulls in (`types: []`, and the provider is referenced only from
 *  vitest.browser.config.ts). So tsc sees no fields on those options at all and
 *  would wave through any object. Declaring the shapes locally and pinning each
 *  call with `satisfies` is what keeps the positions type-checked — and, unlike
 *  a cast, it stays a real check if the augmentation ever does reach this
 *  program. */
interface DragPositions {
  readonly sourcePosition: Point;
  readonly targetPosition: Point;
}
interface ClickPosition {
  readonly position: Point;
}

/** A TRUSTED pointer drag: real `mousedown` → `mousemove`s → `mouseup` →
 *  `click`, dispatched by the browser itself rather than by `new MouseEvent`.
 *  That matters because the whole contract under test is about which events the
 *  widget's root listeners actually receive from a native gesture inside
 *  CodeMirror's contenteditable.
 *
 *  The widget keeps ownership of the gesture end to end — CM's
 *  `eventBelongsToEditor()` skips its own mousedown/mouseup/click handling (and
 *  its `observer.flush()`) for events under a widget whose `ignoreEvent()`
 *  returns true, and `DOMObserver.onSelectionChange` early-returns under the
 *  same condition, so no mid-drag reveal can pull the widget out from under the
 *  pointer. `TableBlockWidget.ignoreEvent()` returns true unconditionally. */
export async function dragPointer(
  source: HTMLElement,
  sourcePt: Point,
  target: HTMLElement,
  targetPt: Point
): Promise<void> {
  await userEvent.dragAndDrop(source, target, {
    sourcePosition: toLocal(source, sourcePt),
    targetPosition: toLocal(target, targetPt),
  } satisfies DragPositions);
}

/** A TRUSTED click at one viewport point (press and release with no travel). */
export async function clickPointer(target: HTMLElement, pt: Point): Promise<void> {
  await userEvent.click(target, { position: toLocal(target, pt) } satisfies ClickPosition);
}

/** Reveal fired: the widget was dropped and the raw source is back on screen. */
export function revealed(v: EditorView): boolean {
  return (
    v.contentDOM.querySelector(".quoll-table-block") === null &&
    (v.contentDOM.textContent ?? "").includes("| gamma | delta |")
  );
}

/** Force the observer pass a widget-internal DOM mutation would trigger, so a
 *  survival check is deterministic instead of frame-timing luck. `observer` is
 *  internal to EditorView, so assert it is really there — a rename upstream must
 *  fail loudly rather than silently vacate the pin. */
export function flushObserver(v: EditorView): void {
  const observer = (v as unknown as { observer?: { flush?: () => void } }).observer;
  expect(typeof observer?.flush, "EditorView.observer.flush must exist").toBe("function");
  (observer as { flush: () => void }).flush();
}

/** The legacy caret-from-point arm of `defaultCaretResolver`, isolated.
 *
 *  Not a redundant copy of production: `defaultCaretResolver` prefers
 *  `caretPositionFromPoint` whenever it exists, and Playwright's bundled
 *  Chromium is far past the Chrome 128 that shipped it — so on this runner the
 *  fallback would otherwise get ZERO real-geometry coverage even though it is
 *  the LIVE path on the extension's floor (`engines.vscode ^1.94` = Chromium
 *  124, which has no `caretPositionFromPoint`). Injected through the
 *  `quollTableCaretResolver` facet seam, which exists for exactly this.
 *
 *  No existence guard: `caretRangeFromPoint` is still present in every Chromium
 *  this suite can run on, and a silent skip would leave the floor unpinned. If
 *  it ever disappears, `cellPointAt`'s fail-closed catch turns the missing
 *  method into a caret instead of a range and the assertions go red. */
export const legacyCaretResolver: CaretResolver = (x, y, doc) => {
  const range = doc.caretRangeFromPoint(x, y);
  return range === null ? null : { node: range.startContainer, offset: range.startOffset };
};
