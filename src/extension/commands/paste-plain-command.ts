// `quoll.pastePlain` command + active-panel forwarding.
//
// Resolve the target after the clipboard read so the panel active at arrival
// receives the text, even if focus changed while the read was pending.

import { commands, type Disposable, env, window } from "vscode";
import { buildPastePlainMessage } from "../../shared/protocol.js";
import { showSafely } from "../surface/show-safely.js";
import { getActivePanelPost } from "./active-panel.js";

export async function runPastePlainCommand(readText = () => env.clipboard.readText()) {
  let text: string;
  try {
    text = await readText();
  } catch (err) {
    console.error("[quoll] could not read the clipboard", err);
    showSafely(window.showErrorMessage("Quoll: could not read the clipboard."), "showErrorMessage");
    return;
  }
  if (text === "") {
    return;
  }
  getActivePanelPost()?.(buildPastePlainMessage(text));
}

export function registerPastePlainCommand(): Disposable {
  return commands.registerCommand("quoll.pastePlain", runPastePlainCommand);
}
