// Host-side gate for webview "update-config" requests. Pure-function (deps
// injected) so it unit-tests without a live VS Code host — mirrors
// handle-open-external.ts. The webview is the untrusted boundary: even though
// isWebviewToHost already rejects an unknown key / out-of-enum value, this arm
// RE-validates independently (isPrefValue, Object.hasOwn-safe) so a future
// protocol-shaped poster or bundle drift cannot write an arbitrary setting.
//   - A DEFAULT-id selection resets the setting (update(key, undefined)) — VS
//     Code's "back to default" convention — instead of persisting the literal.
//   - A key with a workspace/folder override is NOT written at Global scope
//     (that write would not change the effective value → the UI would snap back
//     silently); an info toast explains why.

import { EDITOR_PREF_DEFAULTS, type EditorPrefKey, isPrefValue } from "../shared/protocol.js";

const OVERRIDE_MESSAGE =
  "Quoll: this setting is overridden by your workspace settings, so the global change was not applied.";
const FAILURE_MESSAGE =
  "Quoll: couldn't save that setting. See the extension host log for details.";

export type HandleUpdateConfigDeps = {
  /** workspace.getConfiguration().update(key, value, Global) binding. `value`
   *  is `undefined` to RESET the key (default-id selection). */
  updateConfig: (key: EditorPrefKey, value: string | undefined) => Thenable<void>;
  /** Whether a workspace / folder override exists for `key` (from config.inspect). */
  inspectOverride: (key: EditorPrefKey) => { workspace: boolean; folder: boolean };
  /** Re-push the current editor-config snapshot to the webview. Called in the
   *  override branch so the popover's pending row clears at once (that branch
   *  writes nothing → no onDidChangeConfiguration → no automatic re-push). */
  repush: () => void;
  showInfo: (message: string) => void;
  showError?: (message: string) => void;
};

export function handleUpdateConfig(key: string, value: string, deps: HandleUpdateConfigDeps): void {
  if (!isPrefValue(key, value)) {
    console.warn("[quoll] update-config rejected: key/value not in allowlist", { key, value });
    return;
  }
  const prefKey = key as EditorPrefKey;
  // The try spans inspectOverride + the override branch + the write so a throw
  // from inspect() (not just the write) lands on the same showError + repush
  // path — otherwise it would unwind out of the unguarded onDidReceiveMessage
  // callback with no toast, no repush, no log.
  try {
    const override = deps.inspectOverride(prefKey);
    if (override.workspace || override.folder) {
      deps.showInfo(OVERRIDE_MESSAGE);
      // Re-push so the popover's pending row clears now (no config write → no
      // config event → no automatic re-push would otherwise reach it).
      deps.repush();
      return;
    }
    // Default id ⇒ reset (remove the settings.json entry) rather than persist
    // the literal default, per VS Code convention.
    const write = value === EDITOR_PREF_DEFAULTS[prefKey] ? undefined : value;
    void Promise.resolve(deps.updateConfig(prefKey, write)).then(undefined, (err: unknown) => {
      console.error("[quoll] update-config write rejected", err);
      deps.showError?.(FAILURE_MESSAGE);
      // On failure the config never changed → no re-push would reach the
      // popover; re-push so its pending row clears at once (uniform with the
      // override branch). 2s fallback stays for silent cases.
      deps.repush();
    });
  } catch (err) {
    console.error("[quoll] update-config threw synchronously", err);
    deps.showError?.(FAILURE_MESSAGE);
    deps.repush();
  }
}
