// Shared error-swallowing guards for the editor-handoff commands. Both the
// Claude-Code and Codex handoff handlers wrap their VS Code side-effects in an
// identical try/catch that logs and degrades gracefully; the only difference is
// the log-context prefix, bound once here. `Thenable` is the ambient VS Code
// promise type (@types/vscode) — no import needed.

/** Build the `tryBool` / `tryShow` guards for a handoff handler, binding the
 *  `[quoll] <logContext>: …` prefix used by both. */
export function makeHandoffGuards(logContext: string): {
  tryBool: (op: () => Thenable<boolean>, label: string) => Promise<boolean>;
  tryShow: (show: (m: string) => Thenable<unknown>, message: string) => Promise<void>;
} {
  async function tryBool(op: () => Thenable<boolean>, label: string): Promise<boolean> {
    try {
      return (await op()) === true;
    } catch (err) {
      console.error(`[quoll] ${logContext}: ${label} failed`, err);
      return false;
    }
  }
  async function tryShow(show: (m: string) => Thenable<unknown>, message: string): Promise<void> {
    try {
      await show(message);
    } catch (err) {
      console.error(`[quoll] ${logContext}: message surface rejected`, err);
    }
  }
  return { tryBool, tryShow };
}
