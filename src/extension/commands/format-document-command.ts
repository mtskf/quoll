// `quoll.formatDocument` command + active-panel forwarding, on the shared
// active-poster latch. Palette-only (no keybinding), no argument; forwards a
// single "format the whole document" signal to the ACTIVE panel's webview,
// which runs the actual CodeMirror transaction. No host mutation here.
import { commands, type Disposable } from "vscode";
import { createActivePoster } from "./active-poster.js";

export type DocFormatPoster = () => void;

const registry = createActivePoster<DocFormatPoster>();

export function setActiveDocFormatPoster(poster: DocFormatPoster): void {
  registry.set(poster);
}
export function clearActiveDocFormatPoster(poster: DocFormatPoster): void {
  registry.clear(poster);
}
export function registerFormatDocumentCommand(): Disposable {
  return commands.registerCommand("quoll.formatDocument", () => {
    registry.get()?.();
  });
}
/** Test seam — do not use in production code. */
export function __getActiveDocPosterForTest(): DocFormatPoster | null {
  return registry.get();
}
