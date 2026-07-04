// Pure heuristic for locating the Claude Code terminal to hand a context
// reference off to. Kept window-free (takes the terminal list as an argument)
// so it unit-tests without a live VS Code host — QuollEditorPanel wires it as
// `findClaudeTerminal: () => pickClaudeTerminal(window.terminals)`.
//
// SAFETY (review fix): match by name ONLY — the FIRST terminal whose name
// contains "claude" (case-insensitive). There is deliberately NO
// `window.activeTerminal` fallback: sending the selection reference to an
// unrelated shell would both misfire (text dumped into the wrong process) and
// be mis-reported as success by handleContextHandoff's truthy-terminal tier
// check. No match → undefined → the caller falls through to the clipboard
// path (zero misfire). The name heuristic is the only Claude Code coupling on
// the host side; see handle-context-handoff.ts's COUPLING NOTE.

/** Return the first terminal whose name matches /claude/i, else undefined.
 *  Generic over `{ name: string }` so it imports no vscode symbol. */
export function pickClaudeTerminal<T extends { name: string }>(
  terminals: readonly T[]
): T | undefined {
  return terminals.find((t) => /claude/i.test(t.name));
}
