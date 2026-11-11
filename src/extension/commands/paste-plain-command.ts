// `quoll.pastePlain` command + active-panel forwarding.
//
// The target panel is captured BEFORE the clipboard read and the message is
// posted only if that panel is still active when the read resolves: a chord
// pressed in A is a request on A, so a switch to B during the read drops it
// rather than editing B (VS Code's own paste action captures its editor before
// awaiting the clipboard for the same reason).

import { commands, type Disposable, env, window } from "vscode";
import { buildPastePlainMessage } from "../../shared/protocol.js";
import { showSafely } from "../surface/show-safely.js";
import { getActivePanelPost } from "./active-panel.js";

export async function runPastePlainCommand(
  readText: () => Thenable<string> = () => env.clipboard.readText()
) {
  const target = getActivePanelPost();
  if (target === null) {
    return;
  }
  let text: string;
  try {
    text = await readText();
  } catch (err) {
    console.error("[quoll] could not read the clipboard", err);
    showSafely(window.showErrorMessage("Quoll: could not read the clipboard."), "showErrorMessage");
    return;
  }
  if (text === "" || getActivePanelPost() !== target) {
    return;
  }
  target(buildPastePlainMessage(text));
}

export function registerPastePlainCommand(): Disposable {
  // The command takes no arguments; readText is the unit-test seam only.
  return commands.registerCommand("quoll.pastePlain", () => runPastePlainCommand());
}
