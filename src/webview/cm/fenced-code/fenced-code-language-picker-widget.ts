// Inline POINT widget (Decoration.widget — NOT a block replace) rendering a
// native <select> language picker pinned to the top-right of a fenced code
// block, left of the copy button (laid out by languagePickerThemeSpec against
// the same `.cm-line.quoll-fenced-code-open` position:relative anchor the copy
// button uses).
//
// UNLIKE the copy button (display-only), the picker MUTATES the document: on
// change it calls setFenceLanguage, which dispatches ONE guarded edit rewriting
// the open fence's language token. A native <select> is keyboard/SR accessible
// with no custom popup; its options are a curated safe set, so the written value
// is always a known identifier (the host write-gate re-validates regardless).
//
// updateDOM(): a language change (a pick OR a source edit of the language word)
// leaves openFrom fixed, so eq is false but updateDOM syncs the value IN PLACE —
// the focused <select> (and keyboard state) is preserved instead of being
// destroyed/recreated on every pick. CM only recreates when openFrom changes.
//
// destroy(): because it mutates, this widget MUST clean up its listeners when CM
// discards the DOM. The copy button can leak a harmless display-only listener; a
// detached picker <select> whose native dropdown is still open during an external
// reseed could otherwise fire a stale `change` and mis-write. Listeners are
// attached with an AbortController signal (tracked per-element in a module
// WeakMap) and aborted in destroy().

import { type EditorView, WidgetType } from "@codemirror/view";
import { setFenceLanguage } from "./fenced-code-language-command.js";
import { LANGUAGE_OPTIONS } from "./fenced-code-languages.js";

export const PICKER_CLASS = "quoll-language-picker";
const PICKER_LABEL = "Code block language";

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

  toDOM(view: EditorView): HTMLElement {
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
        // this.openFrom is the live anchor: updateDOM only keeps this DOM (and its
        // listener) when openFrom is unchanged; an openFrom shift recreates via
        // toDOM. All guards (readOnly, block-gone, no-op) live in the command.
        setFenceLanguage(view, this.openFrom, select.value);
      },
      { signal }
    );

    return select;
  }

  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    // Same slot (openFrom), different language (a pick OR a source edit of the
    // language word): sync the value IN PLACE so the focused <select> — and
    // keyboard state — is preserved (no destroy/recreate). A changed openFrom
    // returns false → CM recreates via toDOM with a correctly-bound listener.
    if (!(dom instanceof HTMLSelectElement)) {
      return false;
    }
    const state = pickerState.get(dom);
    if (state === undefined || state.openFrom !== this.openFrom) {
      return false;
    }
    populateSelect(dom, this.language);
    return true;
  }

  destroy(dom: HTMLElement): void {
    // Remove the change/mousedown listeners so a detached select can never fire a
    // stale write. The select IS the returned dom.
    pickerState.get(dom)?.controller.abort();
    pickerState.delete(dom);
  }

  ignoreEvent(): boolean {
    // Our own listeners drive the edit; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
