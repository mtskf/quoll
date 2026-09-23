// Inline POINT widget (Decoration.widget — NOT a block replace) rendering a native
// <select> language picker for a fenced code block. ONE DOM shape ALWAYS: a
// `quoll-language-picker-label` wrapper holding a decorative square-code icon, the
// <select>, and a decorative dropdown caret. An `is-labeled` modifier class (added
// when a language is set) is a CSS gate the header-bar theme (fencedHeaderBarThemeSpec)
// keys on. The wrapper is display:none by DEFAULT — the picker is READING-mode chrome:
// a bare (is-labeled-absent) block and an editing/revealed block both show NO picker
// (the old floating "Plain text" picker is deliberately suppressed). Only an
// `is-labeled` wrapper on a header-carrier line (the concealed `-fence-hidden` row of
// a bodied block, or the has-language fence line of a bodyless block) is shown, as the
// ChatGPT-style left label (icon before the language name, box chrome stripped), with
// the copy button on the right.
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

import type { EditorView } from "@codemirror/view";
import { QuollWidget } from "../widget-base.js";
import { setFenceLanguage } from "./fenced-code-language-command.js";
import { LANGUAGE_OPTIONS } from "./fenced-code-languages.js";
import type { OpenLineOffset } from "./fenced-code-node.js";

export const PICKER_CLASS = "quoll-language-picker";
/** Wrapper span class (ALWAYS present). `is-labeled` is added when a language is
 *  set — the header-bar theme shows it as the left label ONLY in reading mode (the
 *  block's fence concealed); a bare (`is-labeled`-absent) wrapper and an editing/
 *  revealed labelled wrapper are both hidden. */
export const PICKER_LABEL_CLASS = "quoll-language-picker-label";
export const PICKER_LABELED_CLASS = "is-labeled";
const PICKER_LABEL = "Code block language";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Class on the leading `square-code` icon SVG (left of the language name). */
export const PICKER_ICON_CLASS = "quoll-language-picker-icon";
/** Class on the trailing chevron SVG (the dropdown-affordance caret, right side). */
export const PICKER_CARET_CLASS = "quoll-language-picker-caret";

// Lucide (https://lucide.dev, MIT) glyphs, INLINED as static SVG built via
// createElementNS: per the project's supply-chain default-deny we don't add the
// `lucide` package for two static icons, and createElementNS avoids innerHTML
// (url-choke-point guard). The path constants are exported so the widget test can
// assert each glyph is present. Both are DECORATIVE (aria-hidden); the theme overlays
// them pointer-events:none over the select's padding so clicking anywhere in the
// label — including the icon or the caret — still opens the native dropdown.
//   - `square-code` (leading): a rounded square framing a `< >` chevron.
//   - `chevron-down` (trailing): the caret that signals the language IS a dropdown.
export const SQUARE_CODE_PATH_LEFT = "m10 9-3 3 3 3";
export const SQUARE_CODE_PATH_RIGHT = "m14 15 3-3-3-3";
export const CHEVRON_DOWN_PATH = "m6 9 6 6 6-6";

type IconChild = { tag: "rect" | "path"; attrs: Record<string, string> };

/** Build a Lucide-style 24×24 stroke SVG from its child shapes, tagged with `cls`. */
function makeIcon(cls: string, children: IconChild[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
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
  for (const child of children) {
    const el = document.createElementNS(SVG_NS, child.tag);
    for (const [k, v] of Object.entries(child.attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  }
  return svg;
}

function makeSquareCodeIcon(): SVGSVGElement {
  return makeIcon(PICKER_ICON_CLASS, [
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "3", rx: "2" } },
    { tag: "path", attrs: { d: SQUARE_CODE_PATH_LEFT } },
    { tag: "path", attrs: { d: SQUARE_CODE_PATH_RIGHT } },
  ]);
}

function makeCaretIcon(): SVGSVGElement {
  return makeIcon(PICKER_CARET_CLASS, [{ tag: "path", attrs: { d: CHEVRON_DOWN_PATH } }]);
}

/** The <select> child of a picker wrapper (always present in the one DOM shape). */
function selectOf(dom: HTMLElement): HTMLSelectElement | null {
  return dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
}

// Per-<select> state so updateDOM(dom) can reach the build-time openFrom
// (updateDOM's same-slot guard) WITHOUT the widget instance holding mutable
// state (widgets are value objects). WeakMap so a discarded select is GC'd
// normally.
//
// ⚠️ No longer carries an AbortController: the listeners below are bound with
// the base's per-render `signal` (QuollWidget.render), so QuollWidget's own
// `destroy` (which aborts that signal unconditionally, BEFORE this widget's
// `dispose` even runs) already tears them down — this widget no longer needs
// its own teardown at all. See widget-base.ts's `render` doc comment.
const pickerState = new WeakMap<Element, { openFrom: OpenLineOffset }>();

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

export class LanguagePickerWidget extends QuollWidget {
  readonly widgetName = "LanguagePickerWidget";

  constructor(
    /** Open-line offset of the fenced block. Half the eq() key AND updateDOM's
     *  same-slot guard: an openFrom change forces a fresh toDOM (correct listener
     *  closures); a language-only change updates the value in place. */
    readonly openFrom: OpenLineOffset,
    /** Build-time language token — the other half of eq() and the select's
     *  selected value. */
    readonly language: string
  ) {
    super();
  }

  protected sameAs(other: QuollWidget): boolean {
    return (
      other instanceof LanguagePickerWidget &&
      other.openFrom === this.openFrom &&
      other.language === this.language
    );
  }

  /** Build the <select> (listeners + populate). Shared by every render(). */
  private buildSelect(view: EditorView, signal: AbortSignal): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = PICKER_CLASS;
    select.setAttribute("aria-label", PICKER_LABEL);
    populateSelect(select, this.language);

    pickerState.set(select, { openFrom: this.openFrom });

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

  protected render(view: EditorView, signal: AbortSignal): HTMLElement {
    // ONE DOM shape always: a wrapper holding the decorative icon, the <select>, and
    // the dropdown caret. `is-labeled` (language present) is a CSS gate — the theme
    // shows the wrapper as the left label ONLY in reading mode on a header-carrier
    // line, and hides it otherwise (a bare block and an editing/revealed block show no
    // picker). Keeping ONE shape lets updateDOM sync the language IN PLACE across the
    // "" boundary, so a pick never destroys/recreates the focused <select> (focus +
    // keyboard state preserved, and no self-reentrant destroy while a change handler is
    // on stack).
    const wrap = document.createElement("span");
    wrap.className = PICKER_LABEL_CLASS;
    if (this.language !== "") {
      wrap.classList.add(PICKER_LABELED_CLASS);
    }
    // [square-code icon][<select> language name][chevron caret] — both icons are
    // decorative overlays (theme: pointer-events:none over the select's padding), so
    // the whole label is one clickable dropdown.
    wrap.append(makeSquareCodeIcon(), this.buildSelect(view, signal), makeCaretIcon());
    return wrap;
  }

  protected patchDOM(dom: HTMLElement, _view: EditorView): boolean {
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

  // ⚠️ No `dispose` override: this widget used to abort its own bespoke
  // AbortController here (`destroy(dom)`, pre-QuollWidget). The signal
  // migration above dissolves that need rather than relocating it — both
  // listeners are bound with the base's per-render `signal`, and
  // `QuollWidget.destroy` (widget-base.ts) already aborts that signal
  // UNCONDITIONALLY, before checking whether a subclass `dispose` exists at
  // all. There is nothing left here to tear down.

  ignoreEvent(): boolean {
    // Our own listeners drive the edit; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
