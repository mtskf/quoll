// Vanilla DOM builder for the webview's banner kinds. Pure function over
// (reducer state ⊕ a shell-local persistence flag); the shell rebuilds the
// banner host on every state change via host.replaceChildren(...). No diffing
// — the banner surface is small and a full rebuild keeps the contract simple.
// C8 retired the parse-warning / parse-error banners (no PM-bridge
// parse-warning survives under text-canonical); the host's `edit-rejected` →
// serializeError banner is the only remaining HOST-sourced surface. The second
// surface here is the persistence-degraded notice, driven by a shell-local
// flag (NOT reducer state) — see shell.ts persistIfChanged for why it stays
// shell-local rather than a reducer field.

import type { MarkdownError } from "../markdown/errors.js";
import type { WebviewState } from "./state.js";

export function renderBanners(
  host: HTMLElement,
  state: WebviewState,
  persistenceDegraded: boolean
): void {
  const children: HTMLElement[] = [];
  if (state.serializeError !== null) {
    children.push(serializeErrorBanner(state.serializeError));
  }
  if (persistenceDegraded) {
    children.push(persistenceDegradedBanner());
  }
  host.replaceChildren(...children);
}

function serializeErrorBanner(err: MarkdownError): HTMLElement {
  const div = document.createElement("div");
  div.className = "quoll-banner error";
  div.setAttribute("role", "alert");
  // Test seam only — pinned by shell.test.ts's dispatch-path assertion.
  // Not read by production code.
  div.dataset.code = err.code;
  div.textContent = `Cannot save: ${err.message}`;
  return div;
}

// Unobtrusive notice surfaced when setMetadata persistence has failed
// (src/webview/shell.ts persistIfChanged). The lost data is UI/protocol
// metadata that survives a vscode.setState round-trip (ready/docVersion/
// canWrite/theme) — NOT document content (the on-disk file is untouched),
// so this is role="status" (polite), not role="alert". Self-clears on the
// next successful write. Driven by a shell-local flag (not reducer state)
// passed in as `persistenceDegraded` — see shell.ts for why.
function persistenceDegradedBanner(): HTMLElement {
  const div = document.createElement("div");
  div.className = "quoll-banner notice";
  div.setAttribute("role", "status");
  div.dataset.kind = "persistence-degraded";
  div.textContent =
    "Editor session state isn’t being saved — it will reset when this view reloads.";
  return div;
}
