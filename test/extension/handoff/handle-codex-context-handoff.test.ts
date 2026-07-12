import { describe, expect, it, vi } from "vitest";

import {
  CODEX_ADD_FILE_COMMAND,
  handleCodexContextHandoff,
} from "../../../src/extension/handoff/handle-codex-context-handoff.js";

const URI = { fsPath: "/ws/notes/x.md" };

function deps(overrides: Partial<Parameters<typeof handleCodexContextHandoff>[0]> = {}) {
  const calls: { commands: [string, unknown][]; info: string[]; warn: string[] } = {
    commands: [],
    info: [],
    warn: [],
  };
  const base = {
    documentUri: URI,
    isDirty: false,
    save: vi.fn(async () => true),
    executeCommand: vi.fn(async (id: string, arg: unknown) => {
      calls.commands.push([id, arg]);
    }),
    showInfo: vi.fn(async (m: string) => {
      calls.info.push(m);
    }),
    showWarn: vi.fn(async (m: string) => {
      calls.warn.push(m);
    }),
  };
  return { calls, deps: { ...base, ...overrides } };
}

describe("handleCodexContextHandoff", () => {
  it("adds the whole file to Codex and shows a whole-file info toast", async () => {
    const { calls, deps: d } = deps();
    await handleCodexContextHandoff(d);
    expect(calls.commands).toEqual([[CODEX_ADD_FILE_COMMAND, URI]]);
    expect(calls.info.length).toBe(1);
    expect(calls.info[0]).toMatch(/whole file/i);
    expect(calls.warn).toEqual([]);
  });

  it("does not save a clean buffer", async () => {
    const { deps: d } = deps({ isDirty: false });
    await handleCodexContextHandoff(d);
    expect(d.save).not.toHaveBeenCalled();
  });

  it("saves a dirty buffer before invoking the command", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return true;
    });
    const executeCommand = vi.fn(async () => {
      order.push("command");
    });
    const { deps: d } = deps({ isDirty: true, save, executeCommand });
    await handleCodexContextHandoff(d);
    expect(save).toHaveBeenCalledOnce();
    expect(order).toEqual(["save", "command"]);
  });

  it("aborts with a warning when a dirty buffer fails to save (returns false)", async () => {
    const save = vi.fn(async () => false);
    const { calls, deps: d } = deps({ isDirty: true, save });
    await handleCodexContextHandoff(d);
    expect(save).toHaveBeenCalledOnce();
    expect(calls.commands).toEqual([]); // no stale file handed off
    expect(calls.info).toEqual([]); // no false success
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with a warning when save throws", async () => {
    const save = vi.fn(async () => {
      throw new Error("save failed");
    });
    const { calls, deps: d } = deps({ isDirty: true, save });
    await handleCodexContextHandoff(d);
    expect(calls.commands).toEqual([]);
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with a warning when addFileToThread rejects (Codex missing)", async () => {
    const executeCommand = vi.fn(async () => {
      throw new Error("command 'chatgpt.addFileToThread' not found");
    });
    const { calls, deps: d } = deps({ executeCommand });
    await handleCodexContextHandoff(d);
    expect(calls.info).toEqual([]); // no false success
    expect(calls.warn.length).toBe(1);
  });
});
