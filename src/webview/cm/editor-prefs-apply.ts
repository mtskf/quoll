// Applies editorPrefsField to the .cm-editor host (view.dom) as CSS custom
// properties. A ViewPlugin (not a decoration) because it writes to a DOM element
// OUTSIDE CodeMirror's managed content. view.dom is the element the theme's "&"
// selector targets (font-size) and the ancestor of .cm-content (family /
// line-height / width), so a var set there reaches both. On construction + on
// every editorPrefsField change it sets each non-default var and REMOVES each
// default var so the consuming rule's var(--quoll-editor-*, <today-literal>)
// fallback restores today's exact rendering. Display-only, no document mutation.

import type { Extension } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorPrefKey } from "../../shared/protocol.js";
import {
  DEFAULT_EDITOR_PREFS,
  EDITOR_PREF_CSS_VARS,
  type EditorPrefs,
  editorPrefsField,
  editorPrefToCssValue,
} from "./editor-prefs.js";

const PREF_KEY_BY_FIELD: Record<keyof EditorPrefs, EditorPrefKey> = {
  fontFamily: "quoll.editor.fontFamily",
  fontSize: "quoll.editor.fontSize",
  lineHeight: "quoll.editor.lineHeight",
  contentWidth: "quoll.editor.contentWidth",
};

export function editorPrefsApply(): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly host: HTMLElement;
      constructor(view: EditorView) {
        this.host = view.dom;
        this.apply(view.state.field(editorPrefsField, false) ?? DEFAULT_EDITOR_PREFS);
      }
      update(u: ViewUpdate): void {
        const prev = u.startState.field(editorPrefsField, false);
        const next = u.state.field(editorPrefsField, false);
        if (prev !== next && next !== undefined) {
          this.apply(next);
        }
      }
      private apply(prefs: EditorPrefs): void {
        for (const field of Object.keys(PREF_KEY_BY_FIELD) as (keyof EditorPrefs)[]) {
          const key = PREF_KEY_BY_FIELD[field];
          const cssVar = EDITOR_PREF_CSS_VARS[key];
          const value = editorPrefToCssValue(key, prefs[field]);
          if (value === null) {
            this.host.style.removeProperty(cssVar);
          } else {
            this.host.style.setProperty(cssVar, value);
          }
        }
      }
    }
  );
}
