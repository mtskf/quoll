// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_PREFS, type EditorPrefs } from "../../../src/webview/cm/editor-prefs.js";
import { createSettingsPopover } from "../../../src/webview/cm/outline/settings-popover.js";

let popover: ReturnType<typeof createSettingsPopover> | null = null;
afterEach(() => {
  popover?.destroy();
  popover = null;
  document.body.textContent = "";
  vi.useRealTimers();
});

function make(
  prefs: EditorPrefs = DEFAULT_EDITOR_PREFS,
  onChange = vi.fn(),
  onRequestClose = vi.fn()
) {
  popover = createSettingsPopover({ getPrefs: () => prefs, onChange, onRequestClose });
  document.body.appendChild(popover.el); // construction already synced active state
  return { popover, onChange, onRequestClose };
}

describe("createSettingsPopover", () => {
  it("renders 4 labelled radiogroups", () => {
    const { popover } = make();
    expect(popover.el.querySelectorAll("[role='radiogroup']").length).toBe(4);
  });

  it("marks the default segment active on open", () => {
    const { popover } = make();
    const cozy = popover.el.querySelector("[data-pref-value='cozy']") as HTMLButtonElement;
    expect(cozy.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking a non-active segment posts update-config (no local flip yet)", () => {
    const { popover, onChange } = make();
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.click();
    expect(onChange).toHaveBeenCalledWith("quoll.editor.fontFamily", "serif");
    expect(serif.getAttribute("aria-checked")).toBe("false"); // host is source of truth
  });

  it("clicking the already-active segment is a client-side no-op", () => {
    const { popover, onChange } = make();
    const dflt = popover.el.querySelector("[data-pref-value='default']") as HTMLButtonElement;
    dflt.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("syncFromState reflects a host push (active segment moves)", () => {
    let prefs: EditorPrefs = DEFAULT_EDITOR_PREFS;
    popover = createSettingsPopover({
      getPrefs: () => prefs,
      onChange: vi.fn(),
      onRequestClose: vi.fn(),
    });
    document.body.appendChild(popover.el);
    prefs = { ...prefs, fontFamily: "sans" };
    popover.syncFromState();
    const sans = popover.el.querySelector("[data-pref-value='sans']") as HTMLButtonElement;
    expect(sans.getAttribute("aria-checked")).toBe("true");
  });

  it("a pending segment uses aria-disabled (NOT the disabled attribute) so focus survives", () => {
    const { popover } = make();
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.click();
    expect(serif.getAttribute("aria-disabled")).toBe("true");
    expect(serif.disabled).toBe(false); // never the native attribute
  });

  it("keeps focus inside the popover across a select → pending → echo cycle", () => {
    let prefs: EditorPrefs = DEFAULT_EDITOR_PREFS;
    popover = createSettingsPopover({
      getPrefs: () => prefs,
      onChange: vi.fn(),
      onRequestClose: vi.fn(),
    });
    document.body.appendChild(popover.el);
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.focus();
    serif.click();
    expect(popover.el.contains(document.activeElement)).toBe(true); // pending kept focus
    prefs = { ...prefs, fontFamily: "serif" };
    popover.syncFromState();
    expect(popover.el.contains(document.activeElement)).toBe(true); // echo kept focus
  });

  it("ignores a second click while the row is pending", () => {
    const { popover, onChange } = make();
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    const sans = popover.el.querySelector("[data-pref-value='sans']") as HTMLButtonElement;
    serif.click();
    sans.click(); // same row, still pending → ignored
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("pending state clears on the host echo (syncFromState)", () => {
    let prefs: EditorPrefs = DEFAULT_EDITOR_PREFS;
    popover = createSettingsPopover({
      getPrefs: () => prefs,
      onChange: vi.fn(),
      onRequestClose: vi.fn(),
    });
    document.body.appendChild(popover.el);
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.click();
    expect(serif.classList.contains("pending")).toBe(true);
    prefs = { ...prefs, fontFamily: "serif" };
    popover.syncFromState();
    expect(serif.classList.contains("pending")).toBe(false);
  });

  it("pending state clears via the 2s fallback when no echo arrives", () => {
    vi.useFakeTimers();
    const { popover } = make();
    const serif = popover.el.querySelector("[data-pref-value='serif']") as HTMLButtonElement;
    serif.click();
    expect(serif.classList.contains("pending")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(serif.classList.contains("pending")).toBe(false);
  });

  it("ArrowRight moves roving focus AND selects the newly-focused radio (APG)", () => {
    const { popover, onChange } = make();
    const group = popover.el.querySelector("[role='radiogroup']") as HTMLElement; // fontFamily row
    const radios = [...group.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    // default (index 0) is active; ArrowRight → serif (index 1), focus + select.
    radios[0].focus();
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(radios[1]);
    expect(onChange).toHaveBeenCalledWith("quoll.editor.fontFamily", "serif");
  });

  it("marks the dialog aria-modal so ATs treat it as modal", () => {
    const { popover } = make();
    expect(popover.el.getAttribute("aria-modal")).toBe("true");
  });

  it("focusInitial moves focus to the first group's tabbable radio", () => {
    const { popover } = make();
    popover.focusInitial();
    const firstGroup = popover.el.querySelector("[role='radiogroup']") as HTMLElement;
    const active = firstGroup.querySelector("[tabindex='0']") as HTMLButtonElement;
    expect(document.activeElement).toBe(active);
    expect(popover.el.contains(document.activeElement)).toBe(true);
  });

  it("traps Tab: from the last tabbable radio it wraps to the first", () => {
    const { popover } = make();
    const tabbable = [...popover.el.querySelectorAll<HTMLButtonElement>("[role='radio']")].filter(
      (r) => r.tabIndex === 0
    );
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    last.focus();
    last.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(first);
  });

  it("traps Shift+Tab: from the first tabbable radio it wraps to the last", () => {
    const { popover } = make();
    const tabbable = [...popover.el.querySelectorAll<HTMLButtonElement>("[role='radio']")].filter(
      (r) => r.tabIndex === 0
    );
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(last);
  });

  it("still traps Tab when the no-echo fallback stranded focus on a now-non-tabbable radio", () => {
    vi.useFakeTimers();
    const { popover } = make(); // default prefs, onChange no-op → host never echoes
    const group = popover.el.querySelector("[role='radiogroup']") as HTMLElement; // fontFamily
    const radios = [...group.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    // Arrow-nav from the active default (idx 0) to serif (idx 1): focuses idx 1
    // (tabIndex 0) and arms a pending fallback via activate().
    radios[0].focus();
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].tabIndex).toBe(0);
    // No host echo → the 2s fallback re-derives tabIndex from the (unchanged)
    // prefs, dropping idx 1 back to -1 while focus stays on it.
    vi.advanceTimersByTime(2000);
    expect(radios[1].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(radios[1]); // focus stranded on a non-tabbable radio
    // Tab from this stranded radio must STILL be trapped (wrap to a tab stop),
    // not fall through to native traversal out of the aria-modal dialog.
    const firstTabbable = [
      ...popover.el.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ].filter((r) => r.tabIndex === 0)[0];
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    radios[1].dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(firstTabbable);
  });

  it("Escape delegates to onRequestClose and stops propagation (no self-close)", () => {
    const { popover, onRequestClose } = make();
    const bubbled = vi.fn();
    document.body.addEventListener("keydown", bubbled);
    popover.el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(bubbled).not.toHaveBeenCalled(); // stopPropagation kept it off the sidebar
    document.body.removeEventListener("keydown", bubbled);
  });
});
