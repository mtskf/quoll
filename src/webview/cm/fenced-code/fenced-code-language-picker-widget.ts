// Inline POINT widget (Decoration.widget — NOT a block replace) rendering a native
// <select> language picker for a fenced code block. ONE DOM shape ALWAYS: a
// `quoll-language-picker-label` wrapper holding a decorative square-code icon + the
// <select>. An `is-labeled` modifier class (added when a language is set) is a CSS
// gate the header-bar theme (fencedHeaderBarThemeSpec) keys on: WITHOUT it the
// wrapper collapses (display:contents) and the bare <select> floats top-right
// exactly as before (icon hidden) so a language-less block looks unchanged; WITH it
// the wrapper is the ChatGPT-style left label (icon before the language name, box
// chrome stripped), the copy button on the right.
//
// UNLIKE the copy button (display-only), the picker MUTATES the document: on change
// it calls setFenceLanguage, which dispatches ONE guarded edit rewriting the open
// fence's language token. A native <select> is keyboard/SR accessible with no custom
// popup; its options are a curated safe set, so the written value is always a known
// identifier (the host write-gate re-validates regardless).
//
// updateDOM(): a language change (a pick OR a source edit of the language word,
// INCLUDING crossing the "" boundary between bare and labelled) leaves openFrom
// fixed, so eq is false but updateDOM syncs the value AND toggles `is-labeled` IN
// PLACE — the focused <select> (and keyboard state) is preserved, and there is NO
// destroy/recreate mid-pick (so no self-reentrant destroy while a change handler is
// on the stack). CM only recreates when openFrom changes.
//
// destroy(): because it mutates, this widget MUST clean up its listeners when CM
// discards the DOM. A detached picker <select> whose native dropdown is still open
// during an external reseed could otherwise fire a stale `change` and mis-write.
// Listeners are attached with an AbortController signal (tracked per-<select> in a
// module WeakMap) and aborted in destroy() (which resolves the select out of the
// wrapper).

import { type EditorView, WidgetType } from "@codemirror/view";
import { setFenceLanguage } from "./fenced-code-language-command.js";
import { LANGUAGE_OPTIONS } from "./fenced-code-languages.js";

export const PICKER_CLASS = "quoll-language-picker";
/** Wrapper span class (ALWAYS present). `is-labeled` is added when a language is
 *  set — the header-bar theme keys the left-label layout + icon on it, and hides
 *  the icon / floats the bare <select> top-right when it is absent. */
export const PICKER_LABEL_CLASS = "quoll-language-picker-label";
export const PICKER_LABELED_CLASS = "is-labeled";
const PICKER_LABEL = "Code block language";

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide (https://lucide.dev, MIT) `square-code` glyph — a rounded square framing a
// `< >` chevron. INLINED as static SVG built via createElementNS: per the project's
// supply-chain default-deny we don't add the `lucide` package for one static icon,
// and createElementNS avoids innerHTML (url-choke-point guard). The path constants
// are exported so the widget test can assert the icon is present. The icon is
// DECORATIVE: aria-hidden, and the theme overlays it pointer-events:none on the
// select's left padding so clicking it still opens the native dropdown.
export const SQUARE_CODE_PATH_LEFT = "m10 9-3 3 3 3";
export const SQUARE_CODE_PATH_RIGHT = "m14 15 3-3-3-3";
const SQUARE_CODE_RECT = { width: "18", height: "18", x: "3", y: "3", rx: "2" };

function makeSquareCodeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  const rect = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries(SQUARE_CODE_RECT)) {
    rect.setAttribute(k, v);
  }
  svg.appendChild(rect);
  for (const d of [SQUARE_CODE_PATH_LEFT, SQUARE_CODE_PATH_RIGHT]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** The <select> child of a picker wrapper (always present in the one DOM shape). */
function selectOf(dom: HTMLElement): HTMLSelectElement | null {
  return dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
}

// Per-<select> state so destroy(dom)/updateDOM(dom) can reach the AbortController
// (listener teardown) and the build-time openFrom (updateDOM's same-slot guard)
// WITHOUT the widget instance holding mutable state (widgets are value objects).
// WeakMap so a discarded select is GC'd normally.
const pickerState = new WeakMap<Element, { controller: AbortController; openFrom: number }>();

/** (Re)populate `select` with the curated options — plus the current language as a
 *  prepended option when it is a non-empty value outside the curated list, so an
 *  exotic language round-trips (stays selected) — and set the selected value.
 *  Shared by toDOM (initial) and updateDOM (in-place language sync). Setting
 *  `.value` programmatically does NOT fire a `change` event. */
function populateSelect(select: HTMLSelectElement, language: string): void {
  select.replaceChildren();
  if (language !== "" && !LANGUAGE_OPTIONS.some((o) => o.value === language)) {
    const opt = document.createElement("option");
    opt.value = language;
    opt.textContent = language;
    select.appendChild(opt);
  }
  for (const option of LANGUAGE_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = language;
}

export class LanguagePickerWidget extends WidgetType {
  constructor(
    /** Open-line offset of the fenced block. Half the eq() key AND updateDOM's
     *  same-slot guard: an openFrom change forces a fresh toDOM (correct listener
     *  closures); a language-only change updates the value in place. */
    readonly openFrom: number,
    /** Build-time language token — the other half of eq() and the select's
     *  selected value. */
    readonly language: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof LanguagePickerWidget &&
      other.openFrom === this.openFrom &&
      other.language === this.language
    );
  }

  /** Build the <select> (listeners + populate). Shared by every toDOM. */
  private buildSelect(view: EditorView): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = PICKER_CLASS;
    select.setAttribute("aria-label", PICKER_LABEL);
    populateSelect(select, this.language);

    const controller = new AbortController();
    const { signal } = controller;
    pickerState.set(select, { controller, openFrom: this.openFrom });

    // Block CM's caret-on-mousedown WITHOUT preventDefault (preventDefault would
    // stop the native dropdown opening). stopPropagation keeps the event off CM's
    // content-level mousedown handler.
    select.addEventListener("mousedown", (event) => event.stopPropagation(), { signal });

    select.addEventListener(
      "change",
      (event) => {
        event.stopPropagation();
        // this.openFrom is the live anchor: updateDOM keeps this DOM (and its
        // listener) when openFrom is unchanged; an openFrom shift recreates via
        // toDOM. All guards (readOnly, block-gone, no-op) live in the command.
        setFenceLanguage(view, this.openFrom, select.value);
      },
      { signal }
    );

    return select;
  }

  toDOM(view: EditorView): HTMLElement {
    // ONE DOM shape always: a wrapper holding the decorative icon + the <select>.
    // `is-labeled` (language present) is a CSS gate — the header-bar theme hides the
    // icon and floats the bare select top-right when it is absent (language-less
    // blocks look unchanged), and lays out the left label when present. Keeping ONE
    // shape lets updateDOM sync the language IN PLACE across the "" boundary, so a
    // pick never destroys/recreates the focused <select> (focus + keyboard state
    // preserved, and no self-reentrant destroy while a change handler is on stack).
    const wrap = document.createElement("span");
    wrap.className = PICKER_LABEL_CLASS;
    if (this.language !== "") {
      wrap.classList.add(PICKER_LABELED_CLASS);
    }
    wrap.append(makeSquareCodeIcon(), this.buildSelect(view));
    return wrap;
  }

  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    // Same slot (openFrom), any language change (a pick OR a source edit of the
    // language word, INCLUDING crossing the "" boundary): sync the value + toggle
    // the label modifier IN PLACE so the focused <select> — and keyboard state — is
    // preserved (no destroy/recreate). A changed openFrom returns false → CM
    // recreates via toDOM with a correctly-bound listener.
    const select = selectOf(dom);
    if (select === null) {
      return false;
    }
    const state = pickerState.get(select);
    if (state === undefined || state.openFrom !== this.openFrom) {
      return false;
    }
    populateSelect(select, this.language);
    dom.classList.toggle(PICKER_LABELED_CLASS, this.language !== "");
    return true;
  }

  destroy(dom: HTMLElement): void {
    // Abort the change/mousedown listeners so a detached select can never fire a
    // stale write. dom is the wrapper; the select is its child.
    const select = selectOf(dom);
    if (select === null) {
      return;
    }
    pickerState.get(select)?.controller.abort();
    pickerState.delete(select);
  }

  ignoreEvent(): boolean {
    // Our own listeners drive the edit; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
