// Webview-side source of truth for the 4 preset editor-surface settings.
// The field holds the preset IDS (not CSS values); the CSS-var applier
// (cm/editor-prefs-apply.ts) and the outline settings popover both read it, so
// applied rendering and the popover's active-state can never drift. Display-only
// (no document mutation, byte-identical round-trip). A default id maps to null:
// the applier REMOVES the inline var so the consuming rule's
// var(--quoll-editor-*, <today-literal>) fallback yields today's exact value.

import { StateEffect, StateField } from "@codemirror/state";
import {
  type ContentWidthPref,
  EDITOR_PREF_DEFAULTS,
  type EditorPrefKey,
  type FontFamilyPref,
  type FontSizePref,
  type LineHeightPref,
} from "../../shared/protocol.js";

export type EditorPrefs = {
  fontFamily: FontFamilyPref;
  fontSize: FontSizePref;
  lineHeight: LineHeightPref;
  contentWidth: ContentWidthPref;
};

/** Derived from the protocol's EDITOR_PREF_DEFAULTS (single source) — NOT
 *  hand-written, so it can never drift from the host/package.json defaults. The
 *  per-field cast narrows the string default to each field's union. */
export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontFamily: EDITOR_PREF_DEFAULTS["quoll.editor.fontFamily"] as FontFamilyPref,
  fontSize: EDITOR_PREF_DEFAULTS["quoll.editor.fontSize"] as FontSizePref,
  lineHeight: EDITOR_PREF_DEFAULTS["quoll.editor.lineHeight"] as LineHeightPref,
  contentWidth: EDITOR_PREF_DEFAULTS["quoll.editor.contentWidth"] as ContentWidthPref,
};

export const setEditorPrefsEffect = StateEffect.define<EditorPrefs>();

export const editorPrefsField = StateField.define<EditorPrefs>({
  create: () => DEFAULT_EDITOR_PREFS,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setEditorPrefsEffect)) {
        return e.value;
      }
    }
    return value;
  },
});

/** CSS custom-property name per config key (set on the .cm-editor host). */
export const EDITOR_PREF_CSS_VARS: Record<EditorPrefKey, string> = {
  "quoll.editor.fontFamily": "--quoll-editor-font-family",
  "quoll.editor.fontSize": "--quoll-editor-font-size",
  "quoll.editor.lineHeight": "--quoll-editor-line-height",
  "quoll.editor.contentWidth": "--quoll-editor-content-width",
};

// Concrete CSS value per id (null = default → applier removes the var). Typed
// exhaustively over each key's enum union with `satisfies`, so adding an enum id
// without a mapping is a COMPILE error (no silent default-render).
const CSS_VALUES = {
  "quoll.editor.fontFamily": {
    default: null,
    serif: "Georgia, 'Times New Roman', serif",
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  "quoll.editor.fontSize": {
    small: "calc(var(--vscode-font-size) * 0.9)",
    default: null,
    large: "calc(var(--vscode-font-size) * 1.15)",
    "x-large": "calc(var(--vscode-font-size) * 1.3)",
  },
  "quoll.editor.lineHeight": {
    compact: "1.5",
    cozy: null,
    roomy: "1.9",
  },
  "quoll.editor.contentWidth": {
    narrow: "45em",
    medium: null,
    wide: "75em",
  },
} satisfies {
  "quoll.editor.fontFamily": Record<FontFamilyPref, string | null>;
  "quoll.editor.fontSize": Record<FontSizePref, string | null>;
  "quoll.editor.lineHeight": Record<LineHeightPref, string | null>;
  "quoll.editor.contentWidth": Record<ContentWidthPref, string | null>;
};

/** The CSS value for a preset id, or null when it is the default (var removed). */
export function editorPrefToCssValue(key: EditorPrefKey, value: string): string | null {
  return (CSS_VALUES[key] as Record<string, string | null>)[value] ?? null;
}
