// VS Code 1.94 applies encodeURI to the Uri handoff, turning %2F into %252F.
// For local HTTP(S), pass a string to vscode.open so the original bytes reach
// the native layer as they do for VS Code's own string links. In remote
// windows, env.openExternal keeps tunnelling inside the validated open.
// vscode.open resolves void, so completion counts as delivery and rejection
// flows back to the host's error toast.
import { commands, env } from "vscode";
import { buildExternalUri } from "./build-external-uri.js";

export async function openExternalUrl(href: string): Promise<boolean> {
  if (env.remoteName !== undefined || !/^https?:/i.test(href)) {
    return env.openExternal(buildExternalUri(href));
  }
  await commands.executeCommand("vscode.open", href);
  return true;
}
