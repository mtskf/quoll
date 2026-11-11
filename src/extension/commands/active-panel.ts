import type { HostToWebview } from "../../shared/protocol.js";

// A single-slot "active panel post" latch with identity-guarded clear: a
// panel that lost focus AFTER another became active must not wipe the newer
// post. Shared by the inline-format and format-document commands so the latch
// semantics live in exactly one place.
let active: ((message: HostToWebview) => void) | null = null;

export function setActivePanelPost(post: (message: HostToWebview) => void): void {
  active = post;
}

export function clearActivePanelPost(post: (message: HostToWebview) => void): void {
  if (active === post) {
    active = null;
  }
}

export function getActivePanelPost(): ((message: HostToWebview) => void) | null {
  return active;
}
