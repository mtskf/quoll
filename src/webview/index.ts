// Vanilla entry point. The top-level try/catch is the init-error gate —
// a throw from getHost(), the host subscription, or the editor mount
// paints the init-error banner instead of leaving an unexplained blank
// webview.

import { mountShell } from "./shell.js";

import "./styles.css";

function renderInitErrorBanner(root: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const main = document.createElement("main");
  const banner = document.createElement("div");
  banner.className = "quoll-banner error";
  banner.setAttribute("role", "alert");
  banner.textContent = `Quoll webview failed to start: ${message}`;
  main.appendChild(banner);
  root.replaceChildren(main);
}

const container = document.getElementById("root");
if (!container) {
  // The host HTML template owns this id — if it ever drifts, the webview
  // should crash loudly here rather than silently render nothing.
  throw new Error("Quoll webview: #root container missing");
}
// CSP nonce: stamped on #root by buildWebviewHtml. Read here (NOT via
// document.currentScript — `null` for module scripts) and forwarded to
// the EditorView via shell → editor → EditorView.cspNonce.
const nonce = container.dataset.nonce ?? "";
// Webview-resource base URI for relative image resolution: stamped on #root
// by buildWebviewHtml (data-resource-base-uri). "" when the document is not a
// file (no folder to resolve against). Forwarded shell → editor → facet.
const resourceBaseUri = container.dataset.resourceBaseUri ?? "";

try {
  mountShell(container, { nonce, resourceBaseUri });
} catch (err) {
  console.error("[quoll] webview crashed during init", err);
  renderInitErrorBanner(container, err);
}
