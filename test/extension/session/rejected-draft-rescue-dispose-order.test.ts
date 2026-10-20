// Source-order pin for the dispose-time rejected-draft rescue.
//
// The panel's `onDidDispose` callback is vscode-bound and has no unit harness,
// so the property "the rescue runs before any teardown step that can throw" is
// pinned on the source: `rescueDraft(state.rejection)` must sit before the
// `disposed` dispatch — the first of those steps — inside that callback. After
// it, a throwing dispatch / lint-mirror removal / revert-rescue would take the
// only copy of the refused draft with it.
//
// `rescueDraft` is the one shared helper (also the executor's post-dispose
// rescue dep): `rescueRejectedDraft(` must appear exactly once, inside it, so a
// second inline rescue with different deps cannot appear unnoticed. The
// `disposed` transition does not clear `rejection`, so a rescue moved after a
// healthy dispatch would still work — only this pin sees that order.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Same strip as the panel pins in host-session-step.test.ts: block comments,
// then everything after `//`. The panel's comments mention the `disposed`
// dispatch literally, so an unstripped read fails the exactly-once count below.
const panel = readFileSync(
  new URL("../../../src/extension/session/quoll-editor-panel.ts", import.meta.url),
  "utf8"
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^(.*?)\/\/.*$/gm, "$1");

// Index of `needle`, which must occur exactly once — a missing or duplicated
// anchor would make the order comparison meaningless.
const onlyIndexOf = (needle: string): number => {
  expect(panel.split(needle)).toHaveLength(2);
  return panel.indexOf(needle);
};

describe("panel dispose: rejected-draft rescue ordering", () => {
  it("rescues the rejected draft before the teardown that can throw", () => {
    const callback = onlyIndexOf("webviewPanel.onDidDispose(");
    onlyIndexOf("rescueRejectedDraft(");
    onlyIndexOf("rescueRejectedDraft: rescueDraft");
    const rescue = onlyIndexOf("rescueDraft(state.rejection)");
    const disposedDispatch = onlyIndexOf('dispatch({ type: "disposed" })');
    expect(callback).toBeLessThan(rescue);
    expect(rescue).toBeLessThan(disposedDispatch);
  });
});
