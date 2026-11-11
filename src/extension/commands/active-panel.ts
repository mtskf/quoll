import type { HostToWebview } from "../../shared/protocol.js";
import { createActivePoster } from "./active-poster.js";

// The active panel's `post`: host commands (inline format, format document,
// plain paste) forward their message to the ACTIVE Quoll panel's webview through
// it. This is an active-edge latch, not focus: the focus-dependent commands
// (inline format, plain paste) apply their own hasFocus guard in the webview;
// format document deliberately has none.
const registry = createActivePoster<(message: HostToWebview) => void>();

export function setActivePanelPost(post: (message: HostToWebview) => void): void {
  registry.set(post);
}

export function clearActivePanelPost(post: (message: HostToWebview) => void): void {
  registry.clear(post);
}

export function getActivePanelPost(): ((message: HostToWebview) => void) | null {
  return registry.get();
}
