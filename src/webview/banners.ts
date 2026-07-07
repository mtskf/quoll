// Vanilla DOM builder for the webview’s banner kinds. Pure function over
// reducer state; the shell rebuilds the banner host on every state change via
// host.replaceChildren(...). No diffing — the banner surface is small and a
// full rebuild keeps the contract simple. C8 retired the parse-warning /
// parse-error banners (no PM-bridge parse-warning survives under
// text-canonical); the host’s `edit-rejected` → serializeError banner is the
// only remaining banner surface.

import type { MarkdownError } from "../markdown/errors.js";
import type { WebviewState } from "./state.js";

export function renderBanners(host: HTMLElement, state: WebviewState): void {
  const children: HTMLElement[] = [];
  if (state.serializeError !== null) {
    children.push(serializeErrorBanner(state.serializeError));
  }
  host.replaceChildren(...children);
}

function serializeErrorBanner(err: MarkdownError): HTMLElement {
  const div = document.createElement("div");
  div.className = "quoll-banner error";
  div.setAttribute("role", "alert");
  // Test seam only — pinned by shell.test.ts’s dispatch-path assertion.
  // Not read by production code.
  div.dataset.code = err.code;
  div.textContent = `Cannot save: ${err.message}`;
  return div;
}
