// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_PREFS,
  editorPrefsField,
  setEditorPrefsEffect,
} from "../../../src/webview/cm/editor-prefs.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../../src/webview/cm/outline/index.js";
import {
  DEFAULT_WIDTH_PX,
  OUTLINE_OPEN_CLASS,
  OUTLINE_PINNED_CLASS,
} from "../../../src/webview/cm/outline/outline-panel.js";
import { quollUpdateConfigSink } from "../../../src/webview/cm/outline/update-config-sink.js";
import { patchPersistedState, readPersistedState } from "../../../src/webview/host.js";

vi.mock("../../../src/webview/host.js", () => ({
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

function rowEls(host: HTMLElement): HTMLLIElement[] {
  return [...host.querySelectorAll<HTMLLIElement>(".quoll-outline-row")];
}
function twistieOf(row: HTMLLIElement): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(".quoll-outline-twistie");
}
// A row is "visible" when neither it nor an ancestor is collapsed (hidden attr off).
function visibleTexts(host: HTMLElement): string[] {
  return rowEls(host)
    .filter((r) => !r.hidden)
    .map((r) => r.querySelector(".quoll-outline-item")?.textContent ?? "");
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

  it("aligns the first-level row's indent with the OUTLINE header (12px)", () => {
    // Pins the BASE_PAD_PX contract: a top-level (depth 0) heading row's inline
    // paddingLeft (now on the flex row, since the twistie column lives inside it)
    // must equal the header's 12px left inset. Reverting BASE_PAD_PX to 8 makes
    // this red (the row would sit left of the "OUTLINE" label).
    const { host } = mount("# Alpha\n");
    toggleEl(host).click(); // open + build
    const first = host.querySelector<HTMLElement>(".quoll-outline-row");
    expect(first?.style.paddingLeft).toBe("12px");
  });

  it("renders a twistie on rows with children and none on leaves", () => {
    // A > B > C, then D (sibling of A, leaf). A has a child, B has a child, C & D
    // are leaves.
    const { host } = mount("# A\n\n## B\n\n### C\n\n# D\n");
    toggleEl(host).click(); // open + build
    const rows = rowEls(host);
    expect(rows.map((r) => twistieOf(r) !== null)).toEqual([true, true, false, false]);
    // Leaf rows still carry the spacer column so their text aligns with siblings.
    expect(rows[2].querySelector(".quoll-outline-twistie-spacer")).not.toBeNull();
  });

  it("clicking a twistie collapses only that subtree and syncs aria-expanded", () => {
    const { host } = mount("# A\n\n## B\n\n### C\n\n# D\n");
    toggleEl(host).click();
    const bRow = rowEls(host)[1]; // "B"
    const bTwistie = twistieOf(bRow) as HTMLButtonElement;
    // aria-expanded lives on the treeitem row, not the twistie (single source
    // of truth for the tree node's expand state).
    expect(bRow.getAttribute("aria-expanded")).toBe("true");
    bTwistie.click();
    expect(bRow.getAttribute("aria-expanded")).toBe("false");
    // Only C (B's descendant) hides; A, B, D stay.
    expect(visibleTexts(host)).toEqual(["A", "B", "D"]);
  });

  it("collapsing an ancestor hides all descendants; expanding restores them", () => {
    const { host } = mount("# A\n\n## B\n\n### C\n\n# D\n");
    toggleEl(host).click();
    const aTwistie = twistieOf(rowEls(host)[0]) as HTMLButtonElement; // "A"
    aTwistie.click();
    expect(visibleTexts(host)).toEqual(["A", "D"]); // B and C hidden
    aTwistie.click();
    expect(visibleTexts(host)).toEqual(["A", "B", "C", "D"]);
  });

  it("hides descendants correctly with nested collapses (grandparent + parent both collapsed)", () => {
    // A > B > C, with A and B both collapsed. Pins refreshVisibility's shallowest-
    // boundary logic: the deeper collapse (B) is itself hidden under A, and
    // expanding A must reveal B still collapsed (only C stays hidden).
    const { host } = mount("# A\n\n## B\n\n### C\n");
    toggleEl(host).click();
    const aTwistie = twistieOf(rowEls(host)[0]) as HTMLButtonElement;
    const bTwistie = twistieOf(rowEls(host)[1]) as HTMLButtonElement;
    bTwistie.click(); // collapse B (hides C)
    aTwistie.click(); // collapse A (hides B and C)
    expect(visibleTexts(host)).toEqual(["A"]);
    aTwistie.click(); // expand A → B visible again but still collapsed
    expect(visibleTexts(host)).toEqual(["A", "B"]); // C stays hidden under B
    expect(rowEls(host)[1].getAttribute("aria-expanded")).toBe("false"); // B row
  });

  it("preserves a nested row's own collapse state across an ancestor re-expand", () => {
    // A > B > C > D, one level deeper than the sibling test above. Pins that a
    // row's own aria-expanded/hidden state survives an UNRELATED ancestor's
    // collapse+re-expand cycle (not just the shallowest-boundary walk itself).
    const { host } = mount("# A\n\n## B\n\n### C\n\n#### D\n");
    toggleEl(host).click();
    const rows = rowEls(host);
    (twistieOf(rows[2]) as HTMLButtonElement).click(); // collapse C (hides D)
    (twistieOf(rows[1]) as HTMLButtonElement).click(); // collapse B (hides C, D)
    expect(rowEls(host)[2].hidden).toBe(true); // C hidden under collapsed B
    (twistieOf(rowEls(host)[1]) as HTMLButtonElement).click(); // re-expand B
    expect(rowEls(host)[2].hidden).toBe(false);
    expect(rowEls(host)[2].getAttribute("aria-expanded")).toBe("false"); // C row
    expect(rowEls(host)[3].hidden).toBe(true); // D still hidden under collapsed C
  });

  it("demotes the twistie to an aria-hidden decorative chevron (not a tab stop)", () => {
    // The twistie is no longer a focusable <button>: the row is the single
    // focusable tree node (roving tabindex), so the twistie is a decorative
    // <span aria-hidden> with no tabindex. It stays clickable as a pointer
    // affordance (mouse collapse still works).
    const { host } = mount("# A\n\n## B\n");
    toggleEl(host).click();
    const aTwistie = twistieOf(rowEls(host)[0]) as HTMLElement;
    expect(aTwistie.tagName).toBe("SPAN");
    expect(aTwistie.getAttribute("aria-hidden")).toBe("true");
    expect(aTwistie.hasAttribute("tabindex")).toBe(false);
    aTwistie.click(); // pointer affordance still collapses the subtree
    expect(rowEls(host)[0].getAttribute("aria-expanded")).toBe("false"); // A row
  });

  it("keeps a heading collapsed when an edit above shifts its offset (maps collapse through changes)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# A\n\n## B\n\n### C\n");
    v.plugin(outlinePlugin)?.toggle();
    (twistieOf(rowEls(host)[0]) as HTMLButtonElement).click(); // collapse A (hides B, C)
    expect(visibleTexts(host)).toEqual(["A"]);
    // Insert a NEW parent heading (with its own child) above A. A's `from` shifts
    // right; the collapse must follow A and must NOT land on the inserted "# New".
    v.dispatch({ changes: { from: 0, insert: "# New\n\n## New child\n\n" } });
    vi.advanceTimersByTime(250); // let the debounced rebuild fire
    // Without the offset mapping, the stale offset (0) would collapse "# New"
    // instead, yielding ["New", "A", "B", "C"].
    expect(visibleTexts(host)).toEqual(["New", "New child", "A"]);
  });

  it("keeps collapse state across a debounced rebuild", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# A\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle();
    (twistieOf(rowEls(host)[0]) as HTMLButtonElement).click(); // collapse A
    expect(visibleTexts(host)).toEqual(["A"]);
    // Edit that keeps A's from at 0 but changes B's text (signature changes → rebuild).
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# A\n\n## B2\n" } });
    vi.advanceTimersByTime(250);
    expect(visibleTexts(host)).toEqual(["A"]); // still collapsed after rebuild
  });

  it("highlights the nearest visible ancestor when the caret is in a collapsed subtree", () => {
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    (twistieOf(rowEls(host)[0]) as HTMLButtonElement).click(); // collapse A (hides B)
    const bFrom = v.state.doc.line(5).from; // "## B"
    v.dispatch({ selection: EditorSelection.cursor(bFrom) });
    const activeTexts = [...host.querySelectorAll<HTMLElement>(".quoll-outline-item")]
      .filter((el) => el.classList.contains("active"))
      .map((el) => el.textContent);
    expect(activeTexts).toEqual(["A"]); // B is hidden → its visible ancestor A is active
  });

  it("renders a static OUTLINE title with no whole-section fold toggle", () => {
    // The panel has no whole-section fold: the header is a plain label, not a
    // button, and there is no header twistie/chevron to collapse the tree body.
    const { host } = mount("# Alpha\n");
    toggleEl(host).click(); // open
    const title = host.querySelector(".quoll-outline-title");
    expect(title?.textContent).toBe("Outline");
    // The title is a plain span, not a button — no whole-section fold toggle.
    expect(title?.tagName).toBe("SPAN");
    expect(host.querySelector(".quoll-outline-header-toggle")).toBeNull();
  });

  it("exposes the list as a named ARIA tree of treeitems, named from the visible title", () => {
    const { host } = mount("# Alpha\n\n## Beta\n");
    toggleEl(host).click(); // open + build
    const tree = host.querySelector(".quoll-outline-list") as HTMLElement;
    const title = host.querySelector(".quoll-outline-title") as HTMLElement;
    expect(tree.getAttribute("role")).toBe("tree");
    // The tree's accessible name is derived from the visible "Outline" title
    // (not a separate aria-label) so sighted and AT users see the same string.
    expect(title.id).toBeTruthy();
    expect(tree.getAttribute("aria-labelledby")).toBe(title.id);
    expect(tree.getAttribute("aria-label")).toBeNull();
    // Every rendered row is a treeitem (the tree's owned nodes).
    expect(rowEls(host).map((r) => r.getAttribute("role"))).toEqual(["treeitem", "treeitem"]);
  });

  it("sets aria-level from the render depth, collapsing skipped heading levels", () => {
    // h1 → h3 (level 2 skipped): the tree nests h3 directly under h1, so depth is
    // contiguous (0, 1) and aria-level is 1-based off it (1, 2) — NOT the raw
    // heading levels (1, 3).
    const { host } = mount("# A\n\n### C\n\n#### D\n\n# E\n");
    toggleEl(host).click();
    expect(rowEls(host).map((r) => r.getAttribute("aria-level"))).toEqual(["1", "2", "3", "1"]);
  });

  it("puts aria-expanded on parent rows only (leaves have none) and reflects collapse", () => {
    const { host } = mount("# A\n\n## B\n\n### C\n\n# D\n");
    toggleEl(host).click();
    const rows = rowEls(host);
    // A and B have children (expanded); C and D are leaves (no expand state).
    expect(rows.map((r) => r.getAttribute("aria-expanded"))).toEqual(["true", "true", null, null]);
    (twistieOf(rows[0]) as HTMLButtonElement).click(); // collapse A
    expect(rowEls(host)[0].getAttribute("aria-expanded")).toBe("false");
  });

  it("removes aria-expanded when an edit turns a parent heading into a leaf", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# A\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle();
    const aBefore = rowEls(host)[0];
    expect(aBefore.getAttribute("aria-expanded")).toBe("true");
    (twistieOf(aBefore) as HTMLButtonElement).click(); // collapse A first
    expect(rowEls(host)[0].getAttribute("aria-expanded")).toBe("false");
    const bFrom = v.state.doc.line(3).from;
    v.dispatch({ changes: { from: bFrom, to: v.state.doc.length } }); // delete "## B"
    vi.runAllTimers(); // flush the debounced rebuild
    const aAfter = rowEls(host)[0];
    expect(aAfter.getAttribute("aria-expanded")).toBeNull(); // no stale "false"
    expect(twistieOf(aAfter)).toBeNull(); // A is now a leaf
  });

  it("reflects the active heading via aria-selected on the treeitem, moving with the caret", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const selected = () => rowEls(host).map((r) => r.getAttribute("aria-selected"));
    expect(selected()).toEqual(["true", "false"]); // caret at top → Alpha selected
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // "## Beta"
    expect(selected()).toEqual(["false", "true"]);
  });

  it("announces the active-section change to a polite live region (debounced), silent on open", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle(); // open + build → primes baseline silently
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe(""); // opening is not a section change
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → "## Beta"
    expect(announcer.textContent).toBe(""); // debounced — not written yet
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section");
  });

  it("coalesces a rapid caret sweep — cancels the superseded timer, not just last-value-wins", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta (timer A, +400)
    vi.advanceTimersByTime(300); // A still pending
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(3).from) }); // → Alpha: cancels A, arms B
    vi.advanceTimersByTime(150); // t=450 since Beta: A's original deadline has passed
    // Non-vacuous guard: if the clearTimeout were dropped, A would have fired "Beta" by now.
    expect(announcer.textContent).toBe(""); // A was cancelled — nothing spoken yet
    vi.advanceTimersByTime(300); // past B's deadline
    expect(announcer.textContent).toBe("Alpha — current section"); // only the final section
  });

  it("does not re-announce an in-section caret move (same active heading)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(3).from) }); // still under Alpha
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // no section change → nothing spoken
  });

  it("clears a pending announcement when the sidebar closes", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta (pending)
    plugin?.toggle(); // close before the debounce fires
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // never written into the inert sidebar
  });

  it("stays silent while focus is in the tree (row navigation self-announces)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    rowEls(host)[1].focus(); // focus the "Beta" tree row
    expect(document.activeElement).toBe(rowEls(host)[1]);
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // caret → Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // focus in tree → suppressed, no live cue
  });

  it("stays silent on a pinned keyboard Enter-jump and cancels a superseded cue", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open + prime
    pinEl(host).click(); // pin so a jump keeps the sidebar open
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta (timer armed)
    const alphaRow = rowEls(host)[0];
    alphaRow.focus(); // focus in tree
    alphaRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // jumpTo(Alpha)
    vi.runAllTimers();
    // Beta's pending cue is cancelled by the suppressed re-entrant call; the
    // tree-driven jump self-announces its treeitem, so no live cue fires.
    expect(announcer.textContent).toBe("");
  });

  it("records the baseline when a cue is suppressed by tree focus at fire time (no later re-announce)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle();
    pinEl(host).click(); // pin so focus can move to the tree and back without closing
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // caret → Beta (cue armed)
    // Tab into the tree during the debounce window: no transaction fires, so the
    // cue stays armed; the SR announces the treeitem itself.
    rowEls(host)[1].focus();
    vi.runAllTimers(); // cue fires but is suppressed by tree focus — baseline must record Beta
    expect(announcer.textContent).toBe("");
    // Focus back in the editor; an in-section caret move within Beta must NOT re-speak.
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(7).from) }); // still under Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // in-section move → no re-announce
  });

  it("does not baseline the caret's section when a DIFFERENT tree row was focused at fire time", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle();
    pinEl(host).click();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // caret → Beta (cue armed)
    rowEls(host)[0].focus(); // focus the ALPHA row (not Beta) during the window
    vi.runAllTimers(); // cue suppressed, but the tree announced Alpha — Beta stays un-baselined
    expect(announcer.textContent).toBe("");
    // Back in the editor: Beta was never announced, so an in-Beta caret move speaks it.
    v.focus();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(7).from) }); // still under Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section");
  });

  it("re-primes on reopen — no stale announcement the instant the sidebar reopens", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section");
    plugin?.toggle(); // close (clears the region)
    expect(announcer.textContent).toBe("");
    plugin?.toggle(); // reopen with the caret still in Beta — must re-prime silently
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // reopen is not a section change
  });

  it("does not re-announce the same section after an edit merely shifts its offset", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section");
    announcer.textContent = ""; // blank so a *new* write is observable
    // Insert a blank line at the top: Beta's `from` shifts, but the caret maps
    // forward and stays in Beta. Mapping lastAnnouncedFrom must keep the dedup.
    v.dispatch({ changes: { from: 0, insert: "\n" } });
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // mapped dedup → no spurious re-announce
  });

  it("does not announce when a pointer collapse hides the caret's section (caret never moved)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\n## Beta\n\nbody\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(3).from) }); // → Beta (child of Alpha)
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section");
    announcer.textContent = ""; // blank so a spurious write is observable
    // Collapse Alpha via its twistie: Beta (the caret's section) is hidden and the
    // highlight walks up to Alpha, but the caret has not moved.
    const twistie = twistieOf(rowEls(host)[0]) as HTMLElement;
    twistie.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // caret unmoved → no spurious section cue
  });

  it("stays silent when the caret's heading is renamed in place (an edit is not a navigation)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta (cue armed)
    // Rename "## Beta" → "## Gamma" in place before the debounce fires. The caret
    // never moved sections; the edit cancels the pending cue and the rebuild
    // re-baselines silently — no stale "Beta" and no edit-driven "Gamma".
    const betaLine = v.state.doc.line(5);
    v.dispatch({ changes: { from: betaLine.from + 3, to: betaLine.to, insert: "Gamma" } });
    vi.runAllTimers();
    expect(announcer.textContent).toBe("");
  });

  it("stays silent when an edit demotes the caret's heading (section changes without navigation)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\n## Beta\n\nbody\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(3).from) }); // → Beta
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Beta — current section"); // Beta is the baseline
    announcer.textContent = ""; // blank so a spurious write is observable
    // Delete Beta's "## " marker: the caret's enclosing section structurally
    // becomes Alpha, but the caret never moved — a rebuild is not a navigation.
    const betaLine = v.state.doc.line(3);
    v.dispatch({ changes: { from: betaLine.from, to: betaLine.from + 3, insert: "" } });
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // edit-driven section change → silent
  });

  it("cancels a pending cue when the document is edited (an edit is not a navigation)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // → Beta (cue armed)
    vi.advanceTimersByTime(100); // cue still pending
    // Delete the "## " marker so the line is no longer a heading: the pre-edit cue
    // must be cancelled rather than fire off the stale (pre-rebuild) outline. The
    // caret then sits under Alpha (already the baseline), so nothing is spoken.
    const betaLine = v.state.doc.line(5);
    v.dispatch({ changes: { from: betaLine.from, to: betaLine.from + 3, insert: "" } });
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // no stale "Beta", no edit-driven cue
  });

  it("announces empty when the caret sits above the first heading (null active section)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("intro prose\n\n# Alpha\n\nbody\n");
    v.plugin(outlinePlugin)?.toggle();
    const announcer = host.querySelector(".quoll-outline-announcer") as HTMLElement;
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(3).from) }); // → Alpha
    vi.runAllTimers();
    expect(announcer.textContent).toBe("Alpha — current section");
    v.dispatch({ selection: EditorSelection.cursor(0) }); // caret above the first heading → null
    vi.runAllTimers();
    expect(announcer.textContent).toBe(""); // no active section → blank cue
  });

  it("does not mark the empty-state row as a treeitem", () => {
    const { view: v, host } = mount("no headings here\n");
    v.plugin(outlinePlugin)?.toggle();
    const empty = host.querySelector(".quoll-outline-empty") as HTMLElement;
    expect(empty.getAttribute("role")).toBe("none"); // not a treeitem inside role="tree"
  });

  it("switches the tree from treeitems to role=none empty message when the last heading is deleted", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Only\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(rowEls(host).map((r) => r.getAttribute("role"))).toEqual(["treeitem"]);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "no headings here\n" } });
    vi.runAllTimers(); // flush the debounced rebuild
    expect(rowEls(host)).toHaveLength(0);
    const empty = host.querySelector(".quoll-outline-empty") as HTMLElement;
    expect(empty.getAttribute("role")).toBe("none");
  });
});

// focusout bubbles; the sidebar's delegated handler reads e.relatedTarget (the
// element receiving focus). happy-dom's FocusEvent carries relatedTarget from
// its eventInit, so a synthetic event is exactly what the browser would deliver
// on a real Tab-out.
function focusOutSidebar(host: HTMLElement, relatedTarget: EventTarget | null): void {
  sidebarEl(host).dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
}

// The outline is a NON-MODAL role=tree — it never traps Tab (a trap would break
// pinned mode, a persistent pane where Tab must flow between sidebar and editor).
// The one refinement: the transient OVERLAY self-dismisses when focus leaves it,
// so it can't linger over the editor with focus behind it. These pin that policy.
describe("quollOutline overlay focus-out dismiss (non-modal, no Tab trap)", () => {
  it("dismisses the overlay when focus leaves the sidebar to the editor", () => {
    const { view: v, host } = mount("# Alpha\n");
    toggleEl(host).click(); // open (overlay, unpinned)
    pinEl(host).focus(); // focus is inside the sidebar
    focusOutSidebar(host, v.contentDOM); // Tab out into the editor
    expect(isOpen(host)).toBe(false);
    expect(sidebarEl(host).hasAttribute("inert")).toBe(true);
  });

  it("keeps a PINNED sidebar open on focus-out (persistent non-modal pane)", () => {
    const { view: v, host } = mount("# Alpha\n");
    toggleEl(host).click();
    pinEl(host).click(); // pin ⇒ persistent pane
    focusOutSidebar(host, v.contentDOM);
    expect(isOpen(host)).toBe(true); // pinned survives focus-out (guard: this.pinned)
  });

  it("does NOT dismiss when focus moves WITHIN the sidebar (row-to-row nav)", () => {
    const { host } = mount("# Alpha\n\n## Beta\n");
    toggleEl(host).click();
    const rowInside = rowEls(host)[1]; // a treeitem li lives inside the sidebar
    focusOutSidebar(host, rowInside);
    expect(isOpen(host)).toBe(true); // guard: sidebarEl.contains(relatedTarget)
  });

  it("does NOT dismiss on window blur (relatedTarget null — focus left the document)", () => {
    const { host } = mount("# Alpha\n");
    toggleEl(host).click();
    focusOutSidebar(host, null);
    expect(isOpen(host)).toBe(true); // guard: relatedTarget === null keeps it open
  });

  it("does NOT dismiss when focus moves into the footer settings popover", () => {
    // The `sidebarEl.contains(next)` guard specifically protects the footer
    // settings popover, which is DOM-descended from the sidebar (footer is a
    // sidebar child). Unlike row-to-row nav, this pins that the popover stays
    // INSIDE sidebarEl — if a future change portalled it out, this goes red.
    const { host } = mount("# Alpha\n");
    toggleEl(host).click();
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    const radio = document.activeElement as HTMLElement; // focusInitial() landed on a radio in the popover
    expect((host.querySelector(".quoll-settings-popover") as HTMLElement).contains(radio)).toBe(
      true
    );
    focusOutSidebar(host, radio); // gear → radio focus move surfaces as focusout on the sidebar
    expect(isOpen(host)).toBe(true); // guard: the popover radio is inside sidebarEl
  });
});

// keydown targets a focused row <li>; bubbles up to the list's delegated
// handler. happy-dom dispatches a real KeyboardEvent the handler reads .key off.
function rowKeydown(li: HTMLLIElement, key: string): void {
  li.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}
function tabIndexes(host: HTMLElement): number[] {
  return rowEls(host).map((r) => r.tabIndex);
}

describe("quollOutline keyboard tree (roving tabindex)", () => {
  it("exposes a single tab stop — exactly one row is tabindex=0, the rest -1", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n## C\n");
    v.plugin(outlinePlugin)?.toggle();
    const tis = tabIndexes(host);
    expect(tis.filter((t) => t === 0)).toHaveLength(1); // one tab stop for the whole tree
    expect(tis.filter((t) => t === -1)).toHaveLength(tis.length - 1);
    // The tab stop homes onto the caret's heading (caret at top ⇒ first row).
    expect(rowEls(host)[0].tabIndex).toBe(0);
  });

  it("ArrowDown / ArrowUp move focus AND carry the single tab stop with it", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n## C\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[0].focus();
    rowKeydown(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].tabIndex).toBe(0);
    expect(tabIndexes(host).filter((t) => t === 0)).toHaveLength(1); // still just one
    rowKeydown(rows[1], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0].tabIndex).toBe(0);
  });

  it("ArrowUp on the first row and ArrowDown on the last row are no-ops (no wrap)", () => {
    const { view: v, host } = mount("# A\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[0].focus();
    rowKeydown(rows[0], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]); // stayed put
    rows[1].focus();
    rowKeydown(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
  });

  it("Home / End jump focus to the first / last visible row", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n## C\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[1].focus();
    rowKeydown(rows[1], "End");
    expect(document.activeElement).toBe(rows[2]);
    rowKeydown(rows[2], "Home");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("ArrowRight expands a collapsed parent in place (focus stays on the row)", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n### C\n");
    v.plugin(outlinePlugin)?.toggle();
    (twistieOf(rowEls(host)[0]) as HTMLElement).click(); // collapse A (hides B, C)
    const aRow = rowEls(host)[0];
    aRow.focus();
    expect(aRow.getAttribute("aria-expanded")).toBe("false");
    rowKeydown(aRow, "ArrowRight");
    expect(rowEls(host)[0].getAttribute("aria-expanded")).toBe("true"); // expanded
    expect(document.activeElement).toBe(rowEls(host)[0]); // focus unmoved
    expect(visibleTexts(host)).toEqual(["A", "B", "C"]);
  });

  it("ArrowRight on an already-expanded parent moves focus to the first child", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n## C\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[0].focus(); // A, expanded (B and C are its children)
    rowKeydown(rows[0], "ArrowRight");
    expect(document.activeElement).toBe(rows[1]); // first child B
  });

  it("ArrowLeft collapses an expanded parent in place (focus stays on the row)", () => {
    const { view: v, host } = mount("# A\n\n## B\n\n### C\n");
    v.plugin(outlinePlugin)?.toggle();
    const aRow = rowEls(host)[0];
    aRow.focus();
    expect(aRow.getAttribute("aria-expanded")).toBe("true");
    rowKeydown(aRow, "ArrowLeft");
    expect(rowEls(host)[0].getAttribute("aria-expanded")).toBe("false"); // collapsed
    expect(document.activeElement).toBe(rowEls(host)[0]); // focus unmoved
    expect(visibleTexts(host)).toEqual(["A"]);
  });

  it("ArrowLeft on a child (leaf) climbs focus to its parent row", () => {
    const { view: v, host } = mount("# A\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[1].focus(); // B is a leaf child of A
    rowKeydown(rows[1], "ArrowLeft");
    expect(document.activeElement).toBe(rows[0]); // parent A
  });

  it("Enter on a focused row jumps to the heading (selection-only, unpinned closes)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const before = v.state.doc.toString();
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[1].focus(); // "Beta"
    rowKeydown(rows[1], "Enter");
    const betaLine = v.state.doc.line(5); // "## Beta"
    expect(v.state.selection.main.head).toBe(betaLine.from);
    expect(v.state.doc.toString()).toBe(before); // byte-identical: no write
    expect(isOpen(host)).toBe(false); // transient navigator: jump = done
  });

  it("re-homes the tab stop onto the caret's heading while the list is unfocused", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(rowEls(host)[0].tabIndex).toBe(0); // caret at top ⇒ Alpha tabbable
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(5).from) }); // "## Beta"
    // Focus is in the editor, not the list ⇒ the tab stop follows the caret so a
    // later Tab enters the tree at Beta.
    expect(rowEls(host)[1].tabIndex).toBe(0);
    expect(tabIndexes(host).filter((t) => t === 0)).toHaveLength(1);
  });

  it("keeps the tab stop on the focused row when the caret moves while the list is focused", () => {
    // The negative branch of the re-home guard: once the user has tabbed into the
    // tree AND arrow-navigated (so focus + the tab stop both sit on Beta), a
    // caret-driven updateActive must NOT yank the tab stop out from under them.
    // Dropping the `!listEl.contains(activeElement)` guard makes this red.
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[0].focus();
    rowKeydown(rows[0], "ArrowDown"); // focusRow(Beta): focus + tab stop now on Beta
    expect(rows[1].tabIndex).toBe(0);
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(1).from) }); // caret → Alpha
    expect(rows[1].tabIndex).toBe(0); // tab stop NOT yanked to the caret's heading
    expect(tabIndexes(host).filter((t) => t === 0)).toHaveLength(1);
  });

  it("re-homes the tab stop off a keyboard-focused descendant when a pointer collapse hides it", () => {
    // ensureTabbableVisible is load-bearing precisely when the list is FOCUSED and
    // a pointer (twistie-click) collapse of an ancestor hides the focused, tabbable
    // descendant: updateActive's re-home is guarded off while focus is in the list,
    // so ensureTabbableVisible is the only thing that moves the sole tabindex=0 off
    // the now-hidden row. Dropping that call strands the tab stop on a display:none
    // row (a roving-tabindex a11y failure) while other tests stay green.
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n\nmore\n");
    v.plugin(outlinePlugin)?.toggle();
    const rows = rowEls(host);
    rows[0].focus();
    rowKeydown(rows[0], "ArrowDown"); // focus + tab stop now on descendant B (list focused)
    expect(rows[1].tabIndex).toBe(0);
    (twistieOf(rows[0]) as HTMLElement).click(); // pointer-collapse A → B hidden
    expect(rows[1].hidden).toBe(true);
    expect(rows[1].tabIndex).toBe(-1); // re-homed off the hidden row
    expect(tabIndexes(host).filter((t) => t === 0)).toHaveLength(1);
    expect(rows[0].tabIndex).toBe(0); // sole tab stop now on a visible row
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

  it("keeps aria-valuenow in sync with the width var during a pointer drag", () => {
    // applyResize must push the live width onto the separator's aria-valuenow on
    // every pointermove (not only on keyboard nudges), so AT reads the width as it
    // is dragged and the final value after release.
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    stubPointerCapture(h);
    h.dispatchEvent(pd(260));
    h.dispatchEvent(pm(300));
    expect(h.getAttribute("aria-valuenow")).toBe("300");
    h.dispatchEvent(pu(300));
    expect(h.getAttribute("aria-valuenow")).toBe("300");
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

// Keyboard resize (A11Y-07): the handle is a focusable WAI-ARIA window splitter.
// happy-dom has no layout ⇒ host.clientWidth is 0, so clampWidth's upper bound is
// MAX_WIDTH_PX (600); Home/End land on the raw 180/600 bounds.
function handleKeydown(host: HTMLElement, key: string): void {
  handleEl(host).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("quollOutline keyboard resize (separator)", () => {
  it("exposes the handle as a focusable window splitter (role/orientation/bounds)", () => {
    const { host } = mount("# Alpha\n");
    const h = handleEl(host);
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-label")).toBe("Resize outline sidebar");
    expect(h.getAttribute("aria-controls")).toBe(sidebarEl(host).id);
    expect(h.getAttribute("aria-valuemin")).toBe("180");
    expect(h.getAttribute("aria-valuemax")).toBe("600");
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute("aria-hidden")).toBeNull(); // no longer hidden from AT
  });

  it("seeds aria-valuenow from the effective width (persisted, else default)", () => {
    vi.mocked(readPersistedState).mockReturnValueOnce({ outlineWidthPx: 320 });
    const { host } = mount("# Alpha\n");
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("320");
  });

  it("aria-valuenow defaults to the stylesheet width when none is persisted", () => {
    const { host } = mount("# Alpha\n");
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("260");
  });

  it("ArrowRight / ArrowLeft nudge the width var by one step and persist it", () => {
    const { host } = mount("# Alpha\n");
    handleKeydown(host, "ArrowRight");
    expect(widthVar(host)).toBe("276px"); // 260 + 16
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("276");
    expect(vi.mocked(patchPersistedState)).toHaveBeenLastCalledWith({ outlineWidthPx: 276 });
    handleKeydown(host, "ArrowLeft");
    expect(widthVar(host)).toBe("260px"); // back down by a step
    expect(vi.mocked(patchPersistedState)).toHaveBeenLastCalledWith({ outlineWidthPx: 260 });
  });

  it("Home / End jump to the min / max width bounds and persist them", () => {
    const { host } = mount("# Alpha\n");
    handleKeydown(host, "End");
    expect(widthVar(host)).toBe("600px");
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("600");
    expect(vi.mocked(patchPersistedState)).toHaveBeenLastCalledWith({ outlineWidthPx: 600 });
    handleKeydown(host, "Home");
    expect(widthVar(host)).toBe("180px");
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("180");
    expect(vi.mocked(patchPersistedState)).toHaveBeenLastCalledWith({ outlineWidthPx: 180 });
  });

  it("ArrowLeft clamps at the minimum (never below MIN_WIDTH_PX)", () => {
    const { host } = mount("# Alpha\n");
    handleKeydown(host, "Home"); // 180
    handleKeydown(host, "ArrowLeft"); // 180 - 16 → clamped back to 180
    expect(widthVar(host)).toBe("180px");
  });

  it("ArrowRight clamps at the maximum (never above MAX_WIDTH_PX)", () => {
    const { host } = mount("# Alpha\n");
    handleKeydown(host, "End"); // 600
    handleKeydown(host, "ArrowRight"); // 600 + 16 → clamped back to 600
    expect(widthVar(host)).toBe("600px");
    expect(handleEl(host).getAttribute("aria-valuenow")).toBe("600");
  });

  it("ignores unrelated keys (no width change, nothing persisted)", () => {
    const { host } = mount("# Alpha\n");
    handleKeydown(host, "Enter");
    handleKeydown(host, "a");
    expect(widthVar(host)).toBe(""); // untouched — falls through to the stylesheet default
    expect(vi.mocked(patchPersistedState)).not.toHaveBeenCalled();
  });

  it("focusing the handle from the overlay sidebar does not dismiss it (focus-out exemption)", () => {
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open as a transient overlay (not pinned)
    const row = rowEls(host)[0];
    row.focus();
    // Tabbing from a sidebar row to the host-level handle emits a sidebar focusout
    // whose relatedTarget is the handle; the exemption keeps the overlay open.
    row.dispatchEvent(new FocusEvent("focusout", { relatedTarget: handleEl(host), bubbles: true }));
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(true);
  });

  it("dismisses the transient overlay when focus leaves the separator to the editor", () => {
    // The mirror of the exemption above: tabbing OFF the handle to an element
    // outside both the sidebar and the handle must dismiss the overlay, so a
    // keyboard user focused on the separator is not trapped over the editor with
    // focus behind it. The handle carries its OWN focusout listener (it lives on
    // the host, not the sidebar) — without it there is no close path from here.
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle(); // open as a transient overlay (not pinned)
    handleEl(host).focus();
    handleEl(host).dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: v.contentDOM, bubbles: true })
    );
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(false);
  });

  it("Escape while focus is on the separator closes the overlay", () => {
    // The handle is a host child, so the sidebar's Escape handler never sees its
    // keydowns — onResizeKeydown handles Escape itself, mirroring the sidebar.
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle();
    handleEl(host).focus();
    handleKeydown(host, "Escape");
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(false);
  });

  it("Escape from the separator hands focus back to the editor (not <body>)", () => {
    // Closing while focus is on the host-child handle must restore editor focus,
    // exactly like Escape from inside the sidebar. setOpen captures the WHOLE
    // outline focus region (sidebar + separator), not just the sidebar — so a
    // handle-focused close calls view.focus() rather than stranding focus on
    // <body> once CSS hides the handle. Mirrors "Escape inside the sidebar
    // closes it, unpins, and hands focus out of the sidebar" above.
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n");
    v.plugin(outlinePlugin)?.toggle(); // open as a transient overlay (not pinned)
    handleEl(host).focus();
    handleKeydown(host, "Escape");
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(false);
    expect(document.activeElement).toBe(v.contentDOM);
  });

  it("keeps a PINNED sidebar open on focus-out from the separator (pinned guard)", () => {
    // The handle's focusout listener reuses onSidebarFocusOut, so its `this.pinned`
    // guard must hold via the handle binding too — not only via the sidebar
    // binding (which the overlay focus-out suite already covers). A pinned pane is
    // persistent: tabbing off the separator to the editor must NOT dismiss it.
    const { view: v, host } = mount("# A\n\nbody\n\n## B\n");
    toggleEl(host).click();
    pinEl(host).click(); // pin ⇒ persistent pane
    handleEl(host).focus();
    handleEl(host).dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: v.contentDOM, bubbles: true })
    );
    expect(host.classList.contains(OUTLINE_OPEN_CLASS)).toBe(true);
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

  it("opening the popover moves focus into it (first radio)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    (host.querySelector(".quoll-outline-settings") as HTMLButtonElement).click();
    const popover = host.querySelector(".quoll-settings-popover") as HTMLElement;
    expect(popover.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("radio");
  });

  it("closing the popover via Escape restores focus to the gear", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    const gear = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    gear.click();
    const popover = host.querySelector(".quoll-settings-popover") as HTMLElement;
    // focus is inside the popover (moved in on open) → Escape should hand it back
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector(".quoll-settings-popover")).toBeNull();
    expect(document.activeElement).toBe(gear);
  });

  it("does NOT restore focus to the gear when focus already left the popover before close", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = mount("# H1");
    hoverToggle(host);
    const gear = host.querySelector(".quoll-outline-settings") as HTMLButtonElement;
    const pin = pinEl(host);
    gear.click(); // opens popover, focusInitial() lands focus on a radio
    pin.focus(); // simulate focus having already left the popover (e.g. via destroy())
    gear.click(); // toggleSettings() → closeSettings() while focus is on `pin`
    expect(host.querySelector(".quoll-settings-popover")).toBeNull();
    expect(document.activeElement).toBe(pin); // NOT yanked back to the gear
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

// DEFAULT_WIDTH_PX (the width the keyboard math + aria-valuenow read before any
// inline drag) must equal styles.css's --quoll-outline-sidebar-width default.
// happy-dom's getComputedStyle is unreliable for custom-property defaults, so
// rather than measure, read the stylesheet source and machine-enforce parity —
// changing the CSS 260px without updating the constant (or vice versa) fails here.
describe("quollOutline default-width CSS contract", () => {
  it("DEFAULT_WIDTH_PX matches styles.css --quoll-outline-sidebar-width", () => {
    // Resolve from the vitest cwd (the repo root) — under `@vitest-environment
    // happy-dom` import.meta.url is not a file: URL, so `new URL(...)` throws.
    const css = readFileSync(resolve(process.cwd(), "src/webview/styles.css"), "utf8");
    const match = css.match(/--quoll-outline-sidebar-width:\s*(\d+)px/);
    expect(match).not.toBeNull();
    expect(Number((match as RegExpMatchArray)[1])).toBe(DEFAULT_WIDTH_PX);
  });
});
