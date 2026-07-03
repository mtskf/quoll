import { describe, expect, it, vi } from "vitest";

import {
  type ProcInfo,
  parseProcessTable,
  pickClaudeTerminal,
  pickClaudeTerminalByProcess,
  subtreeHasClaude,
} from "../../src/extension/find-claude-terminal.js";

type NamedTerminal = { name: string };
type FakeTerminal = { name: string; processId: PromiseLike<number | undefined> };

function term(name: string, pid: number | undefined): FakeTerminal {
  return { name, processId: Promise.resolve(pid) };
}

describe("pickClaudeTerminal", () => {
  it("returns the terminal whose name matches /claude/i", () => {
    const a = { name: "bash" };
    const b = { name: "Claude Code" };
    expect(pickClaudeTerminal([a, b])).toBe(b);
  });

  it("returns the FIRST match when several terminals match", () => {
    const a = { name: "claude-1" };
    const b = { name: "claude-2" };
    expect(pickClaudeTerminal([a, b])).toBe(a);
  });

  it("returns undefined when no terminal name matches (no activeTerminal fallback)", () => {
    const terminals: NamedTerminal[] = [{ name: "bash" }, { name: "zsh" }, { name: "pwsh" }];
    expect(pickClaudeTerminal(terminals)).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(pickClaudeTerminal([])).toBeUndefined();
  });

  it("matches case-insensitively and as a substring", () => {
    expect(pickClaudeTerminal([{ name: "CLAUDE" }])).toEqual({ name: "CLAUDE" });
    expect(pickClaudeTerminal([{ name: "my-claude-term" }])).toEqual({ name: "my-claude-term" });
    expect(pickClaudeTerminal([{ name: "ClAuDe" }])).toEqual({ name: "ClAuDe" });
  });
});

describe("parseProcessTable", () => {
  it("parses `pid ppid comm` rows, keeping comm paths that contain spaces", () => {
    const stdout = [
      "  123   1 /bin/zsh",
      "  456 123 /opt/homebrew/bin/claude",
      "  789 456 /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)",
      "garbage line",
      "",
    ].join("\n");
    expect(parseProcessTable(stdout)).toEqual<ProcInfo[]>([
      { pid: 123, ppid: 1, comm: "/bin/zsh" },
      { pid: 456, ppid: 123, comm: "/opt/homebrew/bin/claude" },
      {
        pid: 789,
        ppid: 456,
        comm: "/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)",
      },
    ]);
  });
});

describe("subtreeHasClaude", () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, comm: "/bin/zsh" }, // terminal shell A
    { pid: 101, ppid: 100, comm: "/opt/homebrew/bin/claude" }, // claude CLI under A
    { pid: 102, ppid: 101, comm: "/bin/zsh" }, // a bash-tool shell spawned by claude
    { pid: 200, ppid: 1, comm: "/bin/zsh" }, // terminal shell B (no claude)
    { pid: 201, ppid: 200, comm: "/usr/bin/vim" },
  ];

  it("finds a claude descendant of the shell", () => {
    expect(subtreeHasClaude(100, procs)).toBe(true);
  });
  it("returns false for a shell with no claude descendant", () => {
    expect(subtreeHasClaude(200, procs)).toBe(false);
  });
  it("matches a native-binary claude by basename", () => {
    const p: ProcInfo[] = [
      { pid: 1, ppid: 0, comm: "/bin/zsh" },
      {
        pid: 2,
        ppid: 1,
        comm: "/Users/m/.vscode/extensions/anthropic.claude-code/native-binary/claude",
      },
    ];
    expect(subtreeHasClaude(1, p)).toBe(true);
  });
  it("does NOT match a `claude` ancestor directory (basename check, not substring)", () => {
    const p: ProcInfo[] = [
      { pid: 1, ppid: 0, comm: "/Users/claude/bin/zsh" },
      { pid: 2, ppid: 1, comm: "/usr/bin/node" },
    ];
    expect(subtreeHasClaude(1, p)).toBe(false);
  });
  it("terminates on a self-referential ppid (no infinite loop)", () => {
    const p: ProcInfo[] = [{ pid: 5, ppid: 5, comm: "/bin/zsh" }];
    expect(subtreeHasClaude(5, p)).toBe(false);
  });
});

describe("pickClaudeTerminalByProcess", () => {
  const table = (): Promise<readonly ProcInfo[]> =>
    Promise.resolve([
      { pid: 100, ppid: 1, comm: "/bin/zsh" },
      { pid: 101, ppid: 100, comm: "/opt/homebrew/bin/claude" }, // claude under terminal 100
      { pid: 300, ppid: 1, comm: "/bin/zsh" }, // terminal 300, no claude
    ]);

  it("prefers a NAME match without ever reading the process table", async () => {
    const getProcessTable = vi.fn(table);
    const named = term("Claude Code", 999);
    const plain = term("zsh", 100);
    expect(await pickClaudeTerminalByProcess([plain, named], undefined, getProcessTable)).toBe(
      named
    );
    expect(getProcessTable).not.toHaveBeenCalled();
  });

  it("detects the /ide terminal by its claude child process when the name does not match (the regression)", async () => {
    const ide = term("zsh", 100); // plain shell terminal running the claude CLI
    const other = term("zsh", 300);
    expect(await pickClaudeTerminalByProcess([other, ide], undefined, table)).toBe(ide);
  });

  it("prioritises the active terminal among process-proven matches", async () => {
    const tableTwoClaude = (): Promise<readonly ProcInfo[]> =>
      Promise.resolve([
        { pid: 100, ppid: 1, comm: "/bin/zsh" },
        { pid: 101, ppid: 100, comm: "/opt/homebrew/bin/claude" },
        { pid: 200, ppid: 1, comm: "/bin/zsh" },
        { pid: 201, ppid: 200, comm: "/opt/homebrew/bin/claude" },
      ]);
    const first = term("zsh", 100);
    const active = term("zsh", 200);
    expect(await pickClaudeTerminalByProcess([first, active], active, tableTwoClaude)).toBe(active);
  });

  it("returns undefined when no terminal is named or runs claude", async () => {
    const a = term("zsh", 300);
    expect(await pickClaudeTerminalByProcess([a], undefined, table)).toBeUndefined();
  });

  it("returns undefined (clipboard fallback) when the process scan throws — never propagates", async () => {
    const a = term("zsh", 100);
    const failing = vi.fn(() => Promise.reject(new Error("no ps")));
    await expect(pickClaudeTerminalByProcess([a], undefined, failing)).resolves.toBeUndefined();
  });

  it("returns undefined for an empty terminal list without scanning", async () => {
    const getProcessTable = vi.fn(table);
    expect(await pickClaudeTerminalByProcess([], undefined, getProcessTable)).toBeUndefined();
    expect(getProcessTable).not.toHaveBeenCalled();
  });
});
