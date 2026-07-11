// Real-chromium layout gates for the outline hover sidebar — the geometry and
// hit-testing happy-dom cannot observe (no layout engine, no hover recompute).
// Pins four contracts:
//   1. hover-open survives the toggle→sidebar handoff with a STATIONARY
//      pointer (the toggle goes pointer-events:none under the pointer; a close
//      scheduled from its hover-recompute leave would flicker-close the
//      sidebar — the design forbids that);
//   2. pinned mode is a REAL 2-column reflow (sidebar static at the left edge,
//      editor column starts where the sidebar ends and actually narrows);
//   3. pinned mode preserves the height chain — .cm-scroller stays the real
//      scroller, so the scroll-hide observer still fires (and the pinned
//      sidebar survives it).
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../../src/webview/styles.css";
import { quollFloatingToolbarScroll } from "../../src/webview/cm/floating-toolbar-scroll.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../src/webview/cm/outline/index.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

const DOC = "# Alpha\n\nbody\n\n## Beta\n\nmore\n";
const LONG_DOC = `# Alpha\n\n${"line\n".repeat(400)}\n## Beta\n`;

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.getElementById("root")?.remove();
});

/** Mount inside the production shell chain (#root → main → .quoll-editor) so
 *  the styles.css height chain resolves and the host is the sidebar's
 *  positioned ancestor — identical structure to the shipped webview. */
function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const root = document.createElement("div");
  root.id = "root";
  const main = document.createElement("main");
  const host = document.createElement("div");
  host.className = "quoll-editor";
  main.appendChild(host);
  root.appendChild(main);
  document.body.appendChild(root);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        quollTheme,
        quollMarkdownLanguage(),
        quollOutline(),
        quollFloatingToolbarScroll(),
      ],
    }),
  });
  return { view, host };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drain pending layout/measure work (rAF x4 — the settled() idiom from
 *  list-hang-layout.browser.test.ts). */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

describe("outline sidebar — real-chromium layout", () => {
  it("hover-open survives the toggle→sidebar handoff without flicker (stationary pointer)", async () => {
    const { host } = mount(DOC);
    const toggle = host.querySelector(".quoll-outline-toggle") as HTMLElement;
    // Playwright's hover() moves the real pointer ONCE to the element centre
    // and leaves it there — no synthetic follow-up moves — so everything after
    // this line runs under a genuinely stationary pointer (the exact r2
    // regression scenario). POSITIVE waits poll (CI-jitter-proof); only the
    // NEGATIVE dwell ("no close fired") needs a real-time sleep, with a margin
    // >5x the 150 ms grace constant.
    await userEvent.hover(toggle);
    await expect
      .poll(() => host.classList.contains("quoll-outline-open"), { timeout: 2000 })
      .toBe(true); // opens once the 120 ms hover-intent elapses
    // The pointer has not moved since. The toggle went pointer-events:none and
    // the sidebar slid in over the same spot; Chromium's hover recompute fires
    // the toggle's pointerleave WITHOUT pointer movement. Dwell well past the
    // 150 ms close grace — and record EVERY class mutation meanwhile: a final
    // "still open" check alone would pass a transient close→reopen flicker,
    // which is the exact bug class this test exists to pin.
    const flickers: number[] = [];
    const mo = new MutationObserver(() => {
      if (!host.classList.contains("quoll-outline-open")) {
        flickers.push(Date.now());
      }
    });
    mo.observe(host, { attributes: true, attributeFilter: ["class"] });
    await sleep(800);
    mo.disconnect();
    expect(flickers).toEqual([]); // never even momentarily closed
    expect(host.classList.contains("quoll-outline-open")).toBe(true);
  });

  it("pin via a real pointer click holds through the grace window (no flicker after pinning)", async () => {
    const { host } = mount(DOC);
    const toggle = host.querySelector(".quoll-outline-toggle") as HTMLElement;
    await userEvent.hover(toggle);
    await expect
      .poll(() => host.classList.contains("quoll-outline-open"), { timeout: 2000 })
      .toBe(true);
    const pin = host.querySelector(".quoll-outline-pin") as HTMLElement;
    await userEvent.click(pin); // real pointer: moves onto the pin, clicks, stays
    expect(host.classList.contains("quoll-outline-pinned")).toBe(true);
    // Any closeTimer armed by hover recompute around the click must have been
    // neutralised by setPinned's cancelScheduledClose. Dwell past the grace:
    await sleep(800);
    expect(host.classList.contains("quoll-outline-open")).toBe(true);
    expect(host.classList.contains("quoll-outline-pinned")).toBe(true);
  });

  it("pinned mode is a real 2-column reflow (static sidebar, narrowed editor column)", async () => {
    // Scope note: this pins the HOST/EDITOR flex reflow — the sidebar going
    // static at the left edge and the editor column narrowing. The reading
    // column's own adaptation inside .cm-editor (flexBasis 60em capped by
    // maxWidth 100%, cm/theme.ts) rides the shared mount's quollTheme but is not
    // asserted here; its full visual check is Task 5's manual check item 5.
    const { view: v, host } = mount(DOC);
    v.plugin(outlinePlugin)?.toggle(); // deliberate open — no pointer involved
    await settled();
    const sidebar = host.querySelector(".quoll-outline-sidebar") as HTMLElement;
    const editorEl = host.querySelector(".cm-editor") as HTMLElement;
    const hostLeft = host.getBoundingClientRect().left;
    const before = editorEl.getBoundingClientRect();
    // Overlay mode: the editor column is NOT reflowed by the open sidebar.
    expect(Math.round(before.left)).toBe(Math.round(hostLeft));
    (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
    await settled();
    expect(host.classList.contains("quoll-outline-pinned")).toBe(true);
    expect(getComputedStyle(sidebar).position).toBe("static");
    const sb = sidebar.getBoundingClientRect();
    const after = editorEl.getBoundingClientRect();
    expect(Math.round(sb.left)).toBe(Math.round(hostLeft)); // sidebar owns the left edge
    expect(Math.round(after.left)).toBe(Math.round(sb.right)); // editor starts where it ends
    expect(after.width).toBeLessThan(before.width); // the column actually narrowed
  });

  it("dragging the resize handle widens the pinned sidebar (real geometry)", async () => {
    const { view: v, host } = mount(DOC);
    v.plugin(outlinePlugin)?.toggle();
    (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
    await settled();
    const sidebar = host.querySelector(".quoll-outline-sidebar") as HTMLElement;
    const before = sidebar.getBoundingClientRect().width;
    const handle = host.querySelector(".quoll-outline-resize-handle") as HTMLElement;
    const rect = handle.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    // Real Chromium has a layout engine + setPointerCapture, so dispatched
    // PointerEvents exercise the true geometry: applyResize reads the live
    // getBoundingClientRect and clampWidth reads the live host width. Drag the
    // handle ~80px to the right and assert the sidebar column actually grew —
    // the desync/clamp bug class happy-dom can't observe.
    const x0 = rect.left + rect.width / 2;
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: x0, clientY: y, pointerId: 1, bubbles: true })
    );
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: x0 + 80, clientY: y, pointerId: 1, bubbles: true })
    );
    handle.dispatchEvent(
      new PointerEvent("pointerup", { clientX: x0 + 80, clientY: y, pointerId: 1, bubbles: true })
    );
    await settled();
    const after = sidebar.getBoundingClientRect().width;
    expect(after).toBeGreaterThan(before + 40); // dragged ~80px right (clamp permitting)
  });

  it("a wide sidebar caps at 80% of the host when the host narrows (editor column survives)", async () => {
    // Codex #182: dropping the CSS max-width made clampWidth the sole bound, but
    // it only runs at restore/drag. min(var, 80%) on the sidebar width /
    // flex-basis / handle re-caps on every layout, so a large dragged width
    // can't squeeze the pinned editor column to zero after the host shrinks.
    const { view: v, host } = mount(DOC);
    const outerRoot = document.getElementById("root") as HTMLElement;
    outerRoot.style.width = "1000px";
    v.plugin(outlinePlugin)?.toggle();
    (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
    // Force a wide width via the same var the drag would set.
    host.style.setProperty("--quoll-outline-sidebar-width", "600px");
    await settled();
    const sidebar = host.querySelector(".quoll-outline-sidebar") as HTMLElement;
    const editorEl = host.querySelector(".cm-editor") as HTMLElement;
    // Wide host: the 600px var is well under 80% of the host, so it's honoured
    // in full (proves the width isn't defaulting to 260 — the narrow cap below
    // would pass vacuously otherwise).
    expect(sidebar.getBoundingClientRect().width).toBeGreaterThan(500);
    // Narrow the host well below the dragged width.
    outerRoot.style.width = "500px";
    await settled();
    const sbW = sidebar.getBoundingClientRect().width;
    const hostW = host.getBoundingClientRect().width;
    expect(sbW).toBeLessThanOrEqual(Math.round(hostW * 0.8) + 1); // capped at 80% of the host
    expect(editorEl.getBoundingClientRect().width).toBeGreaterThan(0); // editor survives
  });

  it("pinned reading column survives CodeMirror's inline flex-basis latch write (⌘⌥K collapse regression)", async () => {
    // Regression for the ⌘⌥K-with-pinned-outline collapse (user report
    // 2026-07-11). Root cause: CodeMirror's DocView keeps a "widest line seen"
    // minWidth latch and writes it as an INLINE `flex-basis: <px>` on
    // `.cm-content` on every DOM-update sync (@codemirror/view DocView). During
    // the hidden→visible reflow the ⌘⌥K handoff triggers, that latch captures a
    // stale tiny width (observed live: 65px); because `.cm-content` is
    // `flex-grow: 0` (cm/theme.ts) it then pins the reading column to that
    // sliver and every line wraps at ~1 char, and the latch only clears on a doc
    // edit — a same-content reseed never releases it, so the collapse sticks.
    // The fix marks the reading-column flex-basis `!important` (cm/theme.ts) so
    // the theme value always beats CM's inline write. Simulate that exact write
    // (a same-element inline `flex-basis`) and assert the column ignores it.
    //
    // Measured synchronously: CM would clear a manual inline write on its next
    // measure, but the USER-visible collapse is precisely this pre-clear frame,
    // and the fix must neutralise it regardless of timing. Without the
    // `!important` this assertion reds (the column drops to ~1 char).
    const { view: v, host } = mount(DOC);
    // A definite, generous host width so the healthy reading column is clearly
    // wide (the latch value below is a ~1-char 65px) and the collapse a
    // regression would produce is unambiguous.
    (document.getElementById("root") as HTMLElement).style.width = "900px";
    v.plugin(outlinePlugin)?.toggle();
    (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
    await settled();
    const content = host.querySelector(".cm-content") as HTMLElement;
    const healthy = content.getBoundingClientRect().width;
    expect(healthy).toBeGreaterThan(400); // reading column is wide before the latch
    content.style.setProperty("flex-basis", "65px"); // mimic CM's DocView latch write
    const afterLatch = content.getBoundingClientRect().width;
    expect(afterLatch).toBeGreaterThan(healthy * 0.9); // the inline write is inert
  });

  it("pinned mode keeps .cm-scroller as the real scroller (scroll-hide fires; sidebar survives)", async () => {
    const { view: v, host } = mount(LONG_DOC);
    v.plugin(outlinePlugin)?.toggle();
    (host.querySelector(".quoll-outline-pin") as HTMLElement).click();
    await settled();
    const scroller = v.scrollDOM;
    // The flex-row host must keep the height chain definite — otherwise the
    // whole document scrolls instead and this expectation reds.
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = 300; // native scroll event follows in a real browser
    await expect
      .poll(() => host.classList.contains("quoll-chrome-hidden"), { timeout: 2000 })
      .toBe(true); // observer saw the scroll → the scroller is real
    expect(host.classList.contains("quoll-outline-open")).toBe(true); // pinned sidebar untouched
    expect(host.classList.contains("quoll-outline-pinned")).toBe(true);
  });
});
