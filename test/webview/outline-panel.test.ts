// @vitest-environment happy-dom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_PREFS,
  editorPrefsField,
  setEditorPrefsEffect,
} from "../../src/webview/cm/editor-prefs.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../src/webview/cm/outline/index.js";
import {
  OUTLINE_COLLAPSED_CLASS,
  OUTLINE_OPEN_CLASS,
  OUTLINE_PINNED_CLASS,
} from "../../src/webview/cm/outline/outline-panel.js";
import { quollUpdateConfigSink } from "../../src/webview/cm/outline/update-config-sink.js";
import { patchPersistedState, readPersistedState } from "../../src/webview/host.js";

vi.mock("../../src/webview/host.js", () => ({
  readPersistedState: vi.fn(() => ({})),
  patchPersistedState: vi.fn(),
}));

let view: EditorView | null = null;
const updateConfigSpy = vi.fn();

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
  vi.useRealTimers();
  vi.mocked(readPersistedState).mockReturnValue({});
  vi.mocked(patchPersistedState).mockClear();
  updateConfigSpy.mockClear();
});

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        quollMarkdownLanguage(),
        editorPrefsField,
        quollUpdateConfigSink.of((key, value) => updateConfigSpy(key, value)),
        quollOutline(),
      ],
    }),
  });
  return { view, host };
}

function itemTexts(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".quoll-outline-item")].map((el) => el.textContent ?? "");
}

function toggleEl(host: HTMLElement): HTMLButtonElement {
  return host.querySelector(".quoll-outline-toggle") as HTMLButtonElement;
}
function sidebarEl(host: HTMLElement): HTMLElement {
  return host.querySelector(".quoll-outline-sidebar") as HTMLElement;
}
function pinEl(host: HTMLElement): HTMLButtonElement {
  return host.querySelector(".quoll-outline-pin") as HTMLButtonElement;
}
function headerToggleEl(host: HTMLElement): HTMLButtonElement {
  return host.querySelector(".quoll-outline-header-toggle") as HTMLButtonElement;
}
// pointerenter/-leave don't bubble; dispatch directly on the listening element.
// happy-dom has no real hit-testing, so a plain Event with the right type is
// exactly what the listeners see.
// NOTE: hover-open has a 120 ms hover-intent delay, so every test that calls
// hoverToggle MUST have fake timers active ({ toFake: ["setTimeout", "clearTimeout"] }).
function hoverToggle(host: HTMLElement): void {
  toggleEl(host).dispatchEvent(new Event("pointerenter"));
  vi.advanceTimersByTime(150); // past the 120 ms hover-intent delay
}
function leaveSidebar(host: HTMLElement): void {
  sidebarEl(host).dispatchEvent(new Event("pointerleave"));
}
function enterSidebar(host: HTMLElement): void {
  sidebarEl(host).dispatchEvent(new Event("pointerenter"));
}
function isOpen(host: HTMLElement): boolean {
  return host.classList.contains(OUTLINE_OPEN_CLASS);
}

describe("quollOutline sidebar", () => {
  it("does not build the list until the sidebar is opened (closed = inert, no items)", () => {
    const { host } = mount("# Alpha\n");
    expect(host.querySelectorAll(".quoll-outline-item")).toHaveLength(0);
    expect(isOpen(host)).toBe(false);
    expect(sidebarEl(host).hasAttribute("inert")).toBe(true);
  });

  it("renders pin + settings controls with SVG icons (settings enabled, opens a dialog)", () => {
    const { host } = mount("# Alpha\n");
    // Keep the existing pin-icon SVG pin (round-3 item 8 — do NOT drop it).
    expect(pinEl(host).querySelector("svg")).not.toBeNull();
    const settings = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    expect(settings.querySelector("svg")).not.toBeNull();
    expect(settings.textContent).toContain("Settings");
    expect(settings.getAttribute("aria-disabled")).toBeNull();
    expect(settings.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("opens on toggle hover (after the hover-intent delay) and lists headings in document order", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n\n## Beta\n\n## Gamma\n");
    toggleEl(host).dispatchEvent(new Event("pointerenter"));
    expect(isOpen(host)).toBe(false); // not yet — hover-intent window
    vi.advanceTimersByTime(150);
    expect(isOpen(host)).toBe(true);
    expect(sidebarEl(host).hasAttribute("inert")).toBe(false);
    expect(itemTexts(host)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("a grazing pointer (enter then leave within the intent delay) never opens", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n");
    toggleEl(host).dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(50); // still inside the 120 ms intent window
    toggleEl(host).dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1000);
    expect(isOpen(host)).toBe(false);
    expect(host.querySelectorAll(".quoll-outline-item")).toHaveLength(0); // no wasted rebuild
  });

  it("still opens via toggle() (Mod-Alt-o path)", () => {
    const { view: v, host } = mount("# Alpha\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(isOpen(host)).toBe(true);
    expect(itemTexts(host)).toEqual(["Alpha"]);
  });

  it("toggle click opens immediately and is idempotent while open (click-to-close is not a path)", () => {
    const { host } = mount("# Alpha\n");
    toggleEl(host).click();
    expect(isOpen(host)).toBe(true); // immediate — no hover-intent delay on click
    toggleEl(host).click(); // while open the toggle is pointer-invisible; a
    expect(isOpen(host)).toBe(true); // synthetic click must NOT flip it closed
  });

  it("Escape inside the sidebar closes it, unpins, and hands focus out of the sidebar", () => {
    const { host } = mount("# Alpha\n");
    toggleEl(host).click();
    pinEl(host).click();
    pinEl(host).focus(); // keyboard user: focus is inside the sidebar
    sidebarEl(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isOpen(host)).toBe(false);
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(false);
    // Focus must land back IN THE EDITOR — not merely leave the sidebar (a
    // dropped view.focus() call would strand it on <body> and still satisfy a
    // weaker "not in the sidebar" assertion). The focus flag is captured
    // BEFORE inert is set — inert may evict focus synchronously.
    const v2 = view as EditorView;
    expect(document.activeElement).toBe(v2.contentDOM);
  });

  it("jump is selection-only AND closes the unpinned sidebar", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const before = v.state.doc.toString();
    hoverToggle(host);
    const items = host.querySelectorAll<HTMLButtonElement>(".quoll-outline-item");
    items[1].click(); // "Beta"
    const betaLine = v.state.doc.line(5); // "## Beta"
    expect(v.state.selection.main.head).toBe(betaLine.from);
    expect(v.state.selection.main.empty).toBe(true);
    expect(v.state.doc.toString()).toBe(before);
    expect(isOpen(host)).toBe(false); // transient navigator: jump = done
  });

  it("closes after the grace delay when the pointer leaves the sidebar", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n");
    hoverToggle(host);
    leaveSidebar(host);
    expect(isOpen(host)).toBe(true); // not yet — grace window
    vi.advanceTimersByTime(200);
    expect(isOpen(host)).toBe(false);
    expect(sidebarEl(host).hasAttribute("inert")).toBe(true);
  });

  it("re-entering the sidebar within the grace delay cancels the close", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n");
    hoverToggle(host);
    leaveSidebar(host);
    vi.advanceTimersByTime(100); // inside the 150ms grace
    enterSidebar(host);
    vi.advanceTimersByTime(1000);
    expect(isOpen(host)).toBe(true);
  });

  it("the toggle's pointerleave never schedules a close (flicker guard — only the sidebar's leave closes)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n");
    hoverToggle(host);
    // At open time the toggle goes pointer-events:none; the browser's hover
    // recompute fires its leave with the pointer stationary. That leave must
    // NOT arm a close — otherwise the sidebar closes under the pointer and a
    // reopen flicker loop starts.
    toggleEl(host).dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1000);
    expect(isOpen(host)).toBe(true);
  });

  it("pinning keeps the sidebar open across pointer-leave and heading jumps", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n\n## Beta\n");
    hoverToggle(host);
    pinEl(host).click();
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(true);
    expect(pinEl(host).classList.contains("pinned")).toBe(true);
    expect(pinEl(host).getAttribute("aria-pressed")).toBe("true");
    leaveSidebar(host);
    vi.advanceTimersByTime(1000);
    expect(isOpen(host)).toBe(true); // pinned survives pointer-leave
    const items = host.querySelectorAll<HTMLButtonElement>(".quoll-outline-item");
    items[1].click();
    expect(isOpen(host)).toBe(true); // pinned survives a jump
  });

  it("unpinning keeps it open until the next pointer-leave", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# Alpha\n");
    hoverToggle(host);
    pinEl(host).click();
    pinEl(host).click(); // unpin
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(false);
    expect(isOpen(host)).toBe(true); // pointer is still inside (it clicked the pin)
    leaveSidebar(host);
    vi.advanceTimersByTime(200);
    expect(isOpen(host)).toBe(false);
  });

  it("closing via toggle() clears the pinned state (invariant: pinned ⇒ open)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v, host } = mount("# Alpha\n");
    hoverToggle(host);
    pinEl(host).click();
    v.plugin(outlinePlugin)?.toggle(); // Mod-Alt-o path
    expect(isOpen(host)).toBe(false);
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(false);
    expect(pinEl(host).getAttribute("aria-pressed")).toBe("false");
  });

  it("refreshes the list when the document changes while open (debounced)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n");
    v.plugin(outlinePlugin)?.toggle(); // immediate rebuild on open
    expect(itemTexts(host)).toEqual(["Alpha"]);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    vi.advanceTimersByTime(250); // let the debounced rebuild fire
    expect(itemTexts(host)).toEqual(["Alpha", "Added"]);
  });

  it("shows an empty state when opened on a document with no headings", () => {
    const { view: v, host } = mount("no headings here\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(host.querySelector(".quoll-outline-empty")?.textContent).toBe("No headings");
    expect(itemTexts(host)).toEqual([]);
  });

  it("cancels the pending debounced rebuild when the sidebar is closed", () => {
    // Fake ONLY setTimeout/clearTimeout so getTimerCount reflects the plugin's
    // own timers (debounce + hover-close) and nothing else.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v } = mount("# Alpha\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open (synchronous rebuild — no timer)
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    expect(vi.getTimerCount()).toBe(1); // the edit scheduled the debounce
    plugin?.toggle(); // close → setOpen(false) must clear the timer
    expect(vi.getTimerCount()).toBe(0); // pinned: FAILS if the clearTimeout is removed
  });

  it("cancels pending debounce AND hover-close timers on destroy", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v, host } = mount("# Alpha\n");
    hoverToggle(host);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    leaveSidebar(host); // schedules the hover-close
    expect(vi.getTimerCount()).toBe(2); // debounce + hover-close
    v.destroy();
    view = null;
    expect(vi.getTimerCount()).toBe(0); // pinned: FAILS if either clearTimeout is removed
  });

  it("removes its DOM and clears the host classes on destroy", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v, host } = mount("# Alpha\n");
    hoverToggle(host);
    pinEl(host).click();
    v.destroy();
    view = null;
    expect(host.querySelector(".quoll-outline-toggle")).toBeNull();
    expect(host.querySelector(".quoll-outline-sidebar")).toBeNull();
    expect(isOpen(host)).toBe(false);
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(false);
  });

  it("pinning a closed sidebar opens it (invariant: pinned ⇒ open, enforced at setPinned)", () => {
    // Clicking pin while the sidebar is CLOSED must not leave {pinned, !open}:
    // the guard in setPinned opens it first, so both classes land together.
    const { host } = mount("# Alpha\n");
    expect(isOpen(host)).toBe(false); // starts closed
    pinEl(host).click(); // pin without opening first
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(true);
    expect(host.classList.contains(OUTLINE_PINNED_CLASS)).toBe(true);
  });

  it("marks the heading enclosing the caret active, and moves it on selection change", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle(); // open + build
    const items = () => [...host.querySelectorAll<HTMLElement>(".quoll-outline-item")];
    expect(items().map((el) => el.classList.contains("active"))).toEqual([true, false]);
    const beta = v.state.doc.line(5).from;
    v.dispatch({ selection: EditorSelection.cursor(beta) });
    expect(items().map((el) => el.classList.contains("active"))).toEqual([false, true]);
  });

  it("labels a bare-# empty heading as (untitled)", () => {
    const { view: v, host } = mount("#\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(itemTexts(host)).toEqual(["(untitled)"]);
  });

  it("the corner toggle renders the menu SVG (no ☰ text glyph)", () => {
    const { host } = mount("# Alpha\n");
    expect(toggleEl(host).querySelector("svg")).not.toBeNull();
    expect(toggleEl(host).textContent).toBe("");
  });

  it("aligns the first-level row's text inset with the OUTLINE header (12px)", () => {
    // Pins the BASE_PAD_PX contract: a top-level (depth 0) heading row's inline
    // paddingLeft must equal the header's 12px left inset. Reverting BASE_PAD_PX
    // to 8 makes this red (the row would sit left of the "OUTLINE" label).
    const { host } = mount("# Alpha\n");
    toggleEl(host).click(); // open + build
    const first = host.querySelector<HTMLElement>(".quoll-outline-item");
    expect(first?.style.paddingLeft).toBe("12px");
  });

  it("starts expanded and the header toggle collapses / expands the tree body", () => {
    const { host } = mount("# Alpha\n");
    toggleEl(host).click(); // open
    const ht = headerToggleEl(host);
    expect(ht.getAttribute("aria-expanded")).toBe("true");
    expect(host.classList.contains(OUTLINE_COLLAPSED_CLASS)).toBe(false);
    ht.click();
    expect(ht.getAttribute("aria-expanded")).toBe("false");
    expect(host.classList.contains(OUTLINE_COLLAPSED_CLASS)).toBe(true);
    ht.click();
    expect(ht.getAttribute("aria-expanded")).toBe("true");
    expect(host.classList.contains(OUTLINE_COLLAPSED_CLASS)).toBe(false);
  });

  it("clicking the pin never toggles the collapse (stopPropagation)", () => {
    const { host } = mount("# Alpha\n");
    toggleEl(host).click(); // open
    pinEl(host).click(); // pin — must NOT collapse
    expect(host.classList.contains(OUTLINE_COLLAPSED_CLASS)).toBe(false);
    expect(headerToggleEl(host).getAttribute("aria-expanded")).toBe("true");
  });

  it("clears the collapsed host class on destroy", () => {
    const { view: v, host } = mount("# Alpha\n");
    toggleEl(host).click();
    headerToggleEl(host).click(); // collapse
    v.destroy();
    view = null;
    expect(host.classList.contains(OUTLINE_COLLAPSED_CLASS)).toBe(false);
  });
});

// Pointer events target the HANDLE element (the plugin binds pointermove /
// pointerup / pointercancel on it + setPointerCapture, not on window), so
// dispatching on the handle in happy-dom triggers those listeners directly.
function handleEl(host: HTMLElement): HTMLElement {
  return host.querySelector(".quoll-outline-resize-handle") as HTMLElement;
}
function widthVar(host: HTMLElement): string {
  return host.style.getPropertyValue("--quoll-outline-sidebar-width").trim();
}
// happy-dom has no Element.setPointerCapture — stub it so the plugin's guarded
// call is a no-op instead of throwing (the impl also optional-chains it).
function stubPointerCapture(el: HTMLElement): void {
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    () => {};
}
function pd(clientX: number): PointerEvent {
  return new PointerEvent("pointerdown", { clientX, pointerId: 1, bubbles: true });
}
function pm(clientX: number): PointerEvent {
  return new PointerEvent("pointermove", { clientX, pointerId: 1 });
}
function pu(clientX: number): PointerEvent {
  return new PointerEvent("pointerup", { clientX, pointerId: 1 });
}

describe("quollOutline resizable width", () => {
  it("applies a persisted width as the host CSS var on mount", () => {
    vi.mocked(readPersistedState).mockReturnValueOnce({ outlineWidthPx: 320 });
    const { host } = mount("# Alpha\n");
    expect(widthVar(host)).toBe("320px");
  });

  it("ignores a non-finite / out-of-range persisted width", () => {
    vi.mocked(readPersistedState).mockReturnValueOnce({ outlineWidthPx: Number.NaN });
    const { host } = mount("# Alpha\n");
    expect(widthVar(host)).toBe(""); // falls through to the stylesheet default
  });

  it("dragging the handle rewrites the width var, clamped to the minimum", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(300));
    expect(widthVar(host)).toBe("300px");
    h.dispatchEvent(pm(10));
    expect(widthVar(host)).toBe("180px"); // clamped to MIN_WIDTH_PX
  });

  it("persists the final width on pointer-up", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(300));
    h.dispatchEvent(pu(300));
    expect(vi.mocked(patchPersistedState)).toHaveBeenCalledWith({ outlineWidthPx: 300 });
  });

  it("pointercancel ends the drag and persists (Codex F5 — released outside frame)", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(300));
    h.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(vi.mocked(patchPersistedState)).toHaveBeenCalledWith({ outlineWidthPx: 300 });
    // A move after the cancel must be ignored (drag ended).
    h.dispatchEvent(pm(500));
    expect(widthVar(host)).toBe("300px");
  });

  it("persists an in-flight width if the view is destroyed mid-drag (eh-F1)", () => {
    const { view: v, host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(300));
    v.destroy();
    view = null;
    expect(vi.mocked(patchPersistedState)).toHaveBeenCalledWith({ outlineWidthPx: 300 });
  });

  it("a click-without-drag (pointerdown→up, no move) persists nothing (eh Issue 2/3)", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pu(260)); // released without a single pointermove
    expect(vi.mocked(patchPersistedState)).not.toHaveBeenCalled();
  });

  it("a pointerdown then immediate destroy (no move) persists nothing (eh Issue 2)", () => {
    const { view: v, host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    v.destroy();
    view = null;
    expect(vi.mocked(patchPersistedState)).not.toHaveBeenCalled();
  });

  it("ignores a FINITE but out-of-range persisted width (the in-range restore guard)", () => {
    // Distinct from the NaN case: 5000 passes Number.isFinite but fails the
    // clampWidth(persisted) === persisted in-range guard (happy-dom has no
    // layout ⇒ upper bound is MAX_WIDTH_PX 600), so it must NOT be applied.
    vi.mocked(readPersistedState).mockReturnValueOnce({ outlineWidthPx: 5000 });
    const { host } = mount("# Alpha\n");
    expect(widthVar(host)).toBe(""); // rejected — falls through to the stylesheet default
  });

  it("clamps an over-wide drag to the maximum (the sole width bound, no CSS max-width)", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(5000)); // far past the ceiling
    // happy-dom: host.clientWidth 0 ⇒ upper bound falls back to MAX_WIDTH_PX.
    expect(widthVar(host)).toBe("600px");
  });

  it("ignores pointermove/up from a second pointer mid-drag (hijack guard)", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260)); // drag owned by pointerId 1
    h.dispatchEvent(pm(300));
    expect(widthVar(host)).toBe("300px");
    // A second pointer's move must not steer the active drag.
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: 450, pointerId: 2 }));
    expect(widthVar(host)).toBe("300px");
    // Nor may its up end/persist the drag.
    h.dispatchEvent(new PointerEvent("pointerup", { clientX: 450, pointerId: 2 }));
    expect(vi.mocked(patchPersistedState)).not.toHaveBeenCalled();
    // Pointer 1 still owns it.
    h.dispatchEvent(pm(320));
    expect(widthVar(host)).toBe("320px");
  });
});

describe("quollOutline settings popover wiring", () => {
  it("gear opens the popover (mounted into the footer) and toggles aria-expanded", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    const gear = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    expect(host.querySelector(".quoll-settings-popover")).toBeNull(); // unmounted while closed
    gear.click();
    expect(host.querySelector(".quoll-settings-popover")).not.toBeNull();
    expect(gear.getAttribute("aria-expanded")).toBe("true");
    gear.click();
    expect(host.querySelector(".quoll-settings-popover")).toBeNull();
    expect(gear.getAttribute("aria-expanded")).toBe("false");
  });

  it("a segment click posts through the injected sink", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    (host.querySelector("[data-pref-value='serif']") as HTMLButtonElement).click();
    expect(updateConfigSpy).toHaveBeenCalledWith("quoll.editor.fontFamily", "serif");
  });

  it("Escape with the popover open closes ONLY the popover (sidebar stays open)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    const gear = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    gear.click();
    const popover = host.querySelector(".quoll-settings-popover") as HTMLElement;
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector(".quoll-settings-popover")).toBeNull(); // popover closed
    expect(isOpen(host)).toBe(true); // sidebar NOT closed
  });

  it("a pointerdown outside the popover (and not on the gear) closes it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    document.dispatchEvent(new Event("pointerdown"));
    expect(host.querySelector(".quoll-settings-popover")).toBeNull();
  });

  it("closing the sidebar closes the popover", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view, host } = mount("# H1");
    hoverToggle(host);
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    view.plugin(outlinePlugin)?.toggle(); // close the sidebar
    expect(host.querySelector(".quoll-settings-popover")).toBeNull();
  });

  it("a SAME-VALUE editorPrefsField push clears the pending row (round-3 item 1)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view, host } = mount("# H1");
    hoverToggle(host);
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    const serif = host.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.click();
    expect(serif.classList.contains("pending")).toBe(true);
    // Simulate the host's override/failure re-push: dispatch the SAME (default)
    // prefs as a FRESH object — the field identity changes even though the value
    // is unchanged, so the outline's update() runs syncFromState() → pending clears.
    view.dispatch({ effects: setEditorPrefsEffect.of({ ...DEFAULT_EDITOR_PREFS }) });
    expect(serif.classList.contains("pending")).toBe(false);
  });
});
