// Pure readers for the 4 editor-preset config keys. The config-get closure is
// injected so these unit-test without a live workspace.getConfiguration(). A
// stored value that is not a known enum id falls back to the key's default —
// defense in depth against a hand-edited settings.json. Defaults + id sets are
// the protocol's single source (EDITOR_PREF_ENUMS / EDITOR_PREF_DEFAULTS).

import { EDITOR_PREF_DEFAULTS, EDITOR_PREF_ENUMS, type EditorPrefKey } from "../shared/protocol.js";
import type { EditorPrefs } from "./session/document-message.js";

export const EDITOR_PREF_KEYS = Object.keys(EDITOR_PREF_ENUMS) as EditorPrefKey[];

export function readEditorPref(
  key: EditorPrefKey,
  get: (key: string, def: string) => string
): string {
  const raw = get(key, EDITOR_PREF_DEFAULTS[key]);
  return (EDITOR_PREF_ENUMS[key] as readonly string[]).includes(raw)
    ? raw
    : EDITOR_PREF_DEFAULTS[key];
}

export function readEditorPrefs(get: (key: string, def: string) => string): EditorPrefs {
  return {
    fontFamily: readEditorPref("quoll.editor.fontFamily", get) as EditorPrefs["fontFamily"],
    fontSize: readEditorPref("quoll.editor.fontSize", get) as EditorPrefs["fontSize"],
    lineHeight: readEditorPref("quoll.editor.lineHeight", get) as EditorPrefs["lineHeight"],
    contentWidth: readEditorPref("quoll.editor.contentWidth", get) as EditorPrefs["contentWidth"],
  };
}

/** A minimal structural view of vscode.ConfigurationChangeEvent — just the
 *  method the predicate calls, so the predicate unit-tests with a plain fake. */
export type ConfigChangeLike = {
  affectsConfiguration(section: string, scope?: unknown): boolean;
};

/** True iff a config change is relevant to THIS document's editor surface. The
 *  4 preset keys are checked WITH `documentUri` (resource-scoped) so a change in
 *  an unrelated folder does not fire; the two boolean keys are checked unscoped
 *  (existing precedent). `boolKeys` are passed in (they live in the panel) to
 *  avoid a cross-module import cycle. */
export function isRelevantConfigChange(
  e: ConfigChangeLike,
  documentUri: unknown,
  boolKeys: readonly string[]
): boolean {
  if (boolKeys.some((k) => e.affectsConfiguration(k))) {
    return true;
  }
  return EDITOR_PREF_KEYS.some((k) => e.affectsConfiguration(k, documentUri));
}
