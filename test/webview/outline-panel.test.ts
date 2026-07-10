// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../src/webview/cm/outline/index.js";
import {
  OUTLINE_OPEN_CLASS,
  OUTLINE_PINNED_CLASS,
} from "../../src/webview/cm/outline/outline-panel.js";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
  vi.useRealTimers();
});

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollOutline()] }),
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

  it("renders pin + settings controls with SVG icons (settings inert + honest to AT)", () => {
    const { host } = mount("# Alpha\n");
    expect(pinEl(host).querySelector("svg")).not.toBeNull();
    const settings = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    expect(settings.querySelector("svg")).not.toBeNull();
    expect(settings.textContent).toContain("Settings");
    expect(settings.getAttribute("aria-disabled")).toBe("true"); // no-op today, say so to AT
    settings.click(); // deliberately a no-op today — must not throw
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
});
