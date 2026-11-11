// Active-panel latch for the forward switch command, on the shared
// active-poster registry. Its own module so the panel and toggle-editor.ts
// (which imports the panel) can both reach it without an import cycle.
import { createActivePoster } from "../commands/active-poster.js";

/** Returns false when the panel does not own `uriKey`; the switch is then not sent. */
export type SwitchPoster = (uriKey: string) => boolean;

const registry = createActivePoster<SwitchPoster>();

export function setActiveSwitchPoster(poster: SwitchPoster): void {
  registry.set(poster);
}
export function clearActiveSwitchPoster(poster: SwitchPoster): void {
  registry.clear(poster);
}
export function getActiveSwitchPoster(): SwitchPoster | null {
  return registry.get();
}
