// Shared webview→host post wrapper. Every postMessage call site swallows a
// transport throw (panel dispose mid-post, structured-clone edge cases) under
// a "[quoll] postMessage(<label>) failed" console.error — this is that one
// block, factored out so the ~9 near-identical copies (edit, lint-diagnostics,
// caret-report, context-handoff, codex-context-handoff, switch-to-text,
// open-external, link-open, image-write) share one implementation. Post-catch
// cleanup (dispatch a banner, clear pending state, ...) stays with each call
// site via the optional `onError` hook or the boolean return value — this
// helper wraps ONLY the post + log.

import type { WebviewToHost } from "../shared/protocol.js";

export type PostMessageHost = {
  postMessage(message: WebviewToHost): void;
};

/** Post `message` to `host`, logging (never throwing) on transport failure.
 *  Returns true on success, false on failure. `label` names the call site in
 *  the log line (e.g. "edit", "open-external") — callers whose cleanup needs
 *  the raw error (e.g. to build a user-facing message) pass `onError`. */
export function safePostMessage(
  host: PostMessageHost,
  message: WebviewToHost,
  label: string,
  onError?: (err: unknown) => void
): boolean {
  try {
    host.postMessage(message);
    return true;
  } catch (err) {
    console.error(`[quoll] postMessage(${label}) failed`, err);
    try {
      onError?.(err);
    } catch (onErrorErr) {
      console.error(`[quoll] onError for postMessage(${label}) threw`, onErrorErr);
    }
    return false;
  }
}
