// The fenced-code language write path — its own file (like task-checkbox-
// command.ts) so the widget and any future caller share ONE guarded dispatch
// without an import cycle. The picker is the only fenced-code widget that mutates
// the document, so it carries the SAME defensive layering as toggleTaskCheckbox:
//   1. readOnly — EditorState.readOnly blocks native input, NOT programmatic
//      dispatch, so a widget change on a read-only doc would still mutate bytes
//      without this explicit check.
//   2. structural resolve — fenceLanguageTargetAt walks the LIVE tree and only
//      resolves a FencedCode whose open line starts exactly at openFrom, so a
//      stale/shifted openFrom writes to the block genuinely at that anchor or
//      (null) nothing.
//   3. no-op guard — languageChangeSpec returns null when nothing changes.
//   4. try/catch — destroyed-view race during webview tear-down.
// isolateHistory.of("full") makes each language change its own undo group.

import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { fenceLanguageTargetAt, languageChangeSpec } from "./fenced-code-language.js";

/** Rewrite the language of the fenced block whose open line begins at `openFrom`
 *  to `chosen` ("" clears it). Returns true when a dispatch was issued, false
 *  when any guard aborted or the dispatch threw on a dead view. NEVER throws;
 *  never partially mutates. */
export function setFenceLanguage(view: EditorView, openFrom: number, chosen: string): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const target = fenceLanguageTargetAt(view.state, openFrom);
  if (target === null) {
    return false;
  }
  const spec = languageChangeSpec(target, chosen);
  if (spec === null) {
    return false;
  }
  try {
    view.dispatch({
      changes: spec,
      userEvent: "input.fence.language",
      annotations: isolateHistory.of("full"),
    });
    return true;
  } catch (err) {
    console.error("[quoll] fence language dispatch failed", err);
    return false;
  }
}
