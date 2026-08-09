// `quoll.formatDocument` command + active-panel forwarding, on the shared
// active-poster latch. Palette-only (no keybinding), no argument; forwards a
// single "format the whole document" signal to the ACTIVE panel's webview,
// which runs the actual CodeMirror transaction. No host mutation here.
import { commands, type Disposable, window } from "vscode";
import { showSafely } from "../surface/show-safely.js";
import { createActivePoster } from "./active-poster.js";

export type DocFormatPoster = () => void;

const registry = createActivePoster<DocFormatPoster>();

export function setActiveDocFormatPoster(poster: DocFormatPoster): void {
  registry.set(poster);
}
export function clearActiveDocFormatPoster(poster: DocFormatPoster): void {
  registry.clear(poster);
}
/** Command body, exported as the unit-test seam. Palette-only and unscoped, so
 *  it is reachable with no Quoll panel active; the optional call this replaces
 *  turned that case into a silent no-op. */
export function runFormatDocumentCommand(): void {
  const post = registry.get();
  if (post === null) {
    showSafely(
      window.showInformationMessage(
        "Quoll: open a Markdown file in the Quoll editor to format the document."
      ),
      "showInformationMessage"
    );
    return;
  }
  post();
}

export function registerFormatDocumentCommand(): Disposable {
  return commands.registerCommand("quoll.formatDocument", runFormatDocumentCommand);
}
/** Test seam — do not use in production code. */
export function __getActiveDocPosterForTest(): DocFormatPoster | null {
  return registry.get();
}
