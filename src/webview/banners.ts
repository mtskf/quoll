// Render the local send-failure banner from reducer state.

// Rebuild the small banner surface on each state change with replaceChildren.

import type { WebviewState } from "./state.js";

export function renderBanners(host: HTMLElement, state: WebviewState): void {
  const children: HTMLElement[] = [];
  if (state.sendFailure !== null) {
    children.push(sendFailureBanner(state.sendFailure));
  }
  host.replaceChildren(...children);
}

function sendFailureBanner(message: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "quoll-banner error";
  div.setAttribute("role", "alert");
  div.textContent = `Cannot send edit: ${message}`;
  return div;
}
