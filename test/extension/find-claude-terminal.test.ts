import { describe, expect, it } from "vitest";

import { pickClaudeTerminal } from "../../src/extension/find-claude-terminal.js";

type FakeTerminal = { name: string };

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
    const terminals: FakeTerminal[] = [{ name: "bash" }, { name: "zsh" }, { name: "pwsh" }];
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
