// Shared vehicle for the hidden→visible-while-narrow→widen corruption window
// (pinned-outline ⌘⌥K handoff, isolated 2026-07-12 — see
// .claude/plans/2026-07-12-visible-edge-viewport-recovery.md). Used by BOTH
// visible-edge-corruption.browser.test.ts (the upstream pin, which must not
// import the recovery plugin) and visible-edge-recovery.browser.test.ts (the
// recovery contract). Not a test file itself (no .browser.test.ts suffix).
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "../../../src/webview/styles.css";
import { quollFloatingToolbarScroll } from "../../../src/webview/cm/floating-toolbar-scroll.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../../src/webview/cm/outline/index.js";
import { quollTheme } from "../../../src/webview/cm/theme.js";

/** ~450 lines with headings so the outline populates and the doc scrolls far. */
export const LONG_DOC = `# Long doc\n\n${Array.from(
  { length: 40 },
  (_, i) =>
    `## Section ${i + 1}\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(2)}\n\n- item one\n- item two\n- item three\n\n`
).join("")}`;

let visState: DocumentVisibilityState = "visible";

/** Shadow document.visibilityState so dispatched visibilitychange events carry
 *  the state we script. Chromium allows an instance-level defineProperty that
 *  shadows the Document.prototype getter; call resetVisibility() in afterEach. */
export function stubVisibility(): void {
  visState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visState,
  });
}

export function setVisibility(state: DocumentVisibilityState): void {
  visState = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Remove the instance-level shadow (restores the prototype getter). */
export function resetVisibility(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}

/** Production shell chain (#root → main → .quoll-editor), same as
 *  outline-sidebar-layout.browser.test.ts. Caller owns view.destroy() +
 *  #root removal (afterEach). */
export function mount(extraExtensions: Extension[]): {
  view: EditorView;
  host: HTMLElement;
  root: HTMLElement;
} {
  const root = document.createElement("div");
  root.id = "root";
  root.style.width = "900px";
  const main = document.createElement("main");
  const host = document.createElement("div");
  host.className = "quoll-editor";
  main.appendChild(host);
  root.appendChild(main);
  document.body.appendChild(root);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: LONG_DOC,
      extensions: [
        quollTheme,
        quollMarkdownLanguage(),
        quollOutline(),
        quollFloatingToolbarScroll(),
        EditorView.lineWrapping,
        ...extraExtensions,
      ],
    }),
  });
  return { view, host, root };
}

export function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Await n animation frames. Frame-based waits scale with actual frame
 *  progress under CI/headless rAF throttling, unlike wall-clock sleeps —
 *  the recovery plugin's wait cap and thaw are frame-based, so its test
 *  vehicle must be too. */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = (): void => {
      if (--left <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Biggest vertical hole in the scroller's visible area not covered by any
 *  rendered .cm-content child (lines or widgets; CM's .cm-gap placeholders
 *  paint nothing, so they are excluded). A healthy viewport has ~0; the
 *  corrupted state has a viewport-sized hole behind the giant .cm-gap. */
export function biggestUncoveredHole(scroller: HTMLElement): number {
  const sRect = scroller.getBoundingClientRect();
  const rects = [...document.querySelectorAll(".cm-content > *:not(.cm-gap)")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.bottom > sRect.top && r.top < sRect.bottom)
    .sort((a, b) => a.top - b.top);
  let hole = 0;
  let cursor = sRect.top;
  for (const r of rects) {
    hole = Math.max(hole, r.top - cursor);
    cursor = Math.max(cursor, r.bottom);
  }
  return Math.max(hole, sRect.bottom - cursor);
}

/** 1-based line number of the document position rendered at the top of the
 *  visible viewport — the behavioural probe for "the user is still where they
 *  were" (and, in the map test, "…shifted by exactly the inserted lines"). */
export function lineNumberAtViewportTop(view: EditorView): number {
  const r = view.scrollDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: r.left + 10, y: r.top + 10 }) ?? 0;
  return view.state.doc.lineAt(pos).number;
}

/** Pin the outline (real 2-column reflow — the trigger condition), scroll
 *  mid-doc, and let layout settle. Returns the settled scrollTop. */
export async function pinAndScroll(view: EditorView, host: HTMLElement): Promise<number> {
  view.plugin(outlinePlugin)?.toggle();
  (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
  await sleep(200);
  view.scrollDOM.scrollTop = 3000;
  await sleep(300);
  return view.scrollDOM.scrollTop;
}

/** Geometry snapshot of the internal scroller — the observable state both
 *  suites compare across the handoff window. The corruption is a HEIGHT-ORACLE
 *  desync: measuring at degenerate width progressively inflates the heightmap
 *  (scrollHeight balloons) and blows the scroll offset out of range, and/or a
 *  viewport-sized .cm-gap leaves a blank hole. scrollTop can move EITHER way
 *  (it followed the inflated heightmap up in the isolated repro), so a
 *  "reset-to-0" check alone is insufficient — the robust signal is scrollHeight
 *  inflation. */
export function captureGeometry(view: EditorView): {
  scrollTop: number;
  scrollHeight: number;
  hole: number;
} {
  const s = view.scrollDOM;
  return {
    scrollTop: s.scrollTop,
    scrollHeight: s.scrollHeight,
    hole: biggestUncoveredHole(s),
  };
}

/** The isolated corruption window: hidden → visible while ~80px narrow for a
 *  short dwell → widen back through a MULTI-STEP ramp. The multi-step ramp is
 *  load-bearing: it mirrors the VS Code splitview *animating* the pinned outline
 *  open across several frames (not a single width jump), which is what makes
 *  CodeMirror's height oracle re-measure at each degenerate intermediate width
 *  and progressively corrupt the heightmap. A single 80→900 jump lets CM
 *  re-measure cleanly at the final width and does NOT reproduce the bug (proven
 *  2026-07-12). No reseed (proven irrelevant). The optional whileHidden callback
 *  runs between the hidden edge and the visible edge (external-edit-while-hidden
 *  scenarios). The final frame-based wait spans the recovery plugin's wait cap
 *  (60 frames) + stability + 2-frame thaw with margin, so both suites observe
 *  the settled end state even under CI rAF throttling. */
export async function runHandoffWindow(
  root: HTMLElement,
  whileHidden?: () => void | Promise<void>
): Promise<void> {
  setVisibility("hidden");
  document.body.style.display = "none";
  await raf();
  await raf();
  if (whileHidden) {
    await whileHidden();
    await raf();
  }
  root.style.width = "80px";
  document.body.style.display = "";
  setVisibility("visible");
  // Ramp the width back up frame-by-frame straight from the visible edge (the
  // splitview animating the pinned outline open) — the intermediate degenerate
  // widths are what corrupt the height oracle. No stable narrow dwell before
  // the ramp: that mirrors the real continuous animation AND keeps the recovery
  // plugin from latching a "settled" narrow width before the ramp finishes.
  for (const w of [120, 200, 320, 480, 640, 780, 900]) {
    root.style.width = `${w}px`;
    await raf();
    await raf();
  }
  await frames(70);
}
