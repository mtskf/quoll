// Pure heuristics for locating the Claude Code terminal to hand a context
// reference off to. Kept window-free (takes the terminal list + a process-table
// reader as arguments) so it unit-tests without a live VS Code host —
// QuollEditorPanel wires it as
// `findClaudeTerminal: () => pickClaudeTerminalByProcess(window.terminals, window.activeTerminal, readProcessTable)`.
//
// TWO detection passes, in order:
//   1. Name match (pickClaudeTerminal): the FIRST terminal whose name contains
//      "claude" — catches the terminal the Claude Code EXTENSION creates
//      (`createTerminal({ name: "Claude Code" })`).
//   2. Process match (pickClaudeTerminalByProcess): when NO terminal is
//      name-matched, walk each terminal's shell-process subtree and accept the
//      first whose descendants include a `claude` executable. This catches the
//      user running the Claude Code CLI (`claude` + `/ide`) in a PLAIN shell
//      terminal — that terminal is named after the shell ("zsh"), NOT "claude",
//      and Claude Code sets no OSC title / no renameable identifier a
//      third-party can read (verified against claude-code 2.1.199's
//      extension.js: it only names terminals IT creates, and surfaces the /ide
//      link via a lockfile + CLAUDE_CODE_SSE_PORT env var, neither exposed as a
//      VS Code Terminal property). The process tree is the only deterministic
//      signal for a plain-shell /ide terminal.
//
// SAFETY (review fix, preserved): still NO bare `window.activeTerminal`
// fallback — a match must be proven by name OR by a `claude` process in the
// terminal's subtree, so the reference is never dumped into an unrelated shell.
// The active terminal is only PRIORITISED among process-proven candidates (so a
// multi-Claude setup hands off to the one the user was just in), never accepted
// unproven. Delivery stays `sendText(text, false)` (no trailing newline →
// non-executing until the user presses Enter). See handle-context-handoff.ts's
// COUPLING NOTE.

/** A single row of the process table: pid, parent pid, executable path/name. */
export type ProcInfo = { pid: number; ppid: number; comm: string };

/** Return the first terminal whose name matches /claude/i, else undefined.
 *  Generic over `{ name: string }` so it imports no vscode symbol. */
export function pickClaudeTerminal<T extends { name: string }>(
  terminals: readonly T[]
): T | undefined {
  return terminals.find((t) => /claude/i.test(t.name));
}

/** Parse `ps -axo pid=,ppid=,comm=` output. Each line is `<pid> <ppid> <comm>`
 *  where comm is an executable path that MAY contain spaces (e.g. macOS app
 *  bundles like ".../Code Helper (Plugin)"), so the first two whitespace-
 *  delimited integers are pid/ppid and the remainder (trimmed) is comm.
 *  Malformed / header lines are skipped. */
export function parseProcessTable(stdout: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/);
    if (m) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] });
    }
  }
  return rows;
}

/** True if `comm`'s basename is EXACTLY the Claude Code CLI executable. Basename
 *  match (not a substring over the whole path) so a `/Users/claude/…` ancestor
 *  directory never false-matches; and EXACT (not `startsWith`) so sibling
 *  binaries like `claude-lsp` / `claude-helper` / `claudette` do NOT pass the
 *  process-proven gate — a prefix match there would let an unrelated terminal
 *  be selected and receive a silent misdelivery. Both the CLI
 *  (`/opt/homebrew/bin/claude`) and the extension native binary
 *  (`…/native-binary/claude`) have the exact basename `claude`. */
function isClaudeExecutable(comm: string): boolean {
  const exe = comm.trim();
  const base = exe.slice(exe.lastIndexOf("/") + 1).toLowerCase();
  return base === "claude";
}

/** True if the process subtree rooted at `rootPid` contains a `claude`
 *  executable. Pure over a supplied process table (no spawning) so it unit-tests
 *  directly. Iterative DFS with a visited set (guards a cyclic / self-
 *  referential ppid). */
export function subtreeHasClaude(rootPid: number, procs: readonly ProcInfo[]): boolean {
  const childrenByPpid = new Map<number, number[]>();
  const commByPid = new Map<number, string>();
  for (const p of procs) {
    commByPid.set(p.pid, p.comm);
    const kids = childrenByPpid.get(p.ppid);
    if (kids) {
      kids.push(p.pid);
    } else {
      childrenByPpid.set(p.ppid, [p.pid]);
    }
  }
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const comm = commByPid.get(pid);
    if (comm !== undefined && isClaudeExecutable(comm)) {
      return true;
    }
    const kids = childrenByPpid.get(pid);
    if (kids) {
      for (const kid of kids) {
        stack.push(kid);
      }
    }
  }
  return false;
}

/** Locate the Claude Code terminal: name match first (the extension's "Claude
 *  Code" terminal), else the first terminal whose shell-process subtree contains
 *  a `claude` executable (the CLI `/ide` case). `getProcessTable` is injected so
 *  this stays testable without spawning; a throw / timeout there → undefined
 *  (clipboard fallback), never an exception out of the handoff. The active
 *  terminal is checked FIRST among process candidates so a multi-Claude setup
 *  hands off to the one the user was just in. Generic over the minimal Terminal
 *  shape so it imports no vscode symbol. */
export async function pickClaudeTerminalByProcess<
  T extends { name: string; processId: PromiseLike<number | undefined> },
>(
  terminals: readonly T[],
  activeTerminal: T | undefined,
  getProcessTable: () => Promise<readonly ProcInfo[]>
): Promise<T | undefined> {
  const named = pickClaudeTerminal(terminals);
  if (named !== undefined) {
    return named;
  }
  if (terminals.length === 0) {
    return undefined;
  }
  let procs: readonly ProcInfo[];
  try {
    procs = await getProcessTable();
  } catch {
    return undefined;
  }
  const runsClaude = async (t: T): Promise<boolean> => {
    let pid: number | undefined;
    try {
      pid = await t.processId;
    } catch {
      pid = undefined;
    }
    return pid !== undefined && subtreeHasClaude(pid, procs);
  };
  if (
    activeTerminal !== undefined &&
    terminals.includes(activeTerminal) &&
    (await runsClaude(activeTerminal))
  ) {
    return activeTerminal;
  }
  for (const t of terminals) {
    if (t !== activeTerminal && (await runsClaude(t))) {
      return t;
    }
  }
  return undefined;
}
