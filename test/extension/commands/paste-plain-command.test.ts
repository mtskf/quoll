import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  clearActivePanelPost,
  getActivePanelPost,
  setActivePanelPost,
} from "../../../src/extension/commands/active-panel.js";
import {
  registerPastePlainCommand,
  runPastePlainCommand,
} from "../../../src/extension/commands/paste-plain-command.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

function releaseActivePoster(): void {
  const active = getActivePanelPost();
  if (active !== null) {
    clearActivePanelPost(active);
  }
}

function deferredRead() {
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { readText: () => promise, resolve, reject };
}

describe("runPastePlainCommand", () => {
  beforeEach(() => {
    releaseActivePoster();
    expect(getActivePanelPost()).toBeNull();
  });

  afterEach(() => {
    releaseActivePoster();
    vi.restoreAllMocks();
  });

  it("posts the clipboard text to the active panel", async () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const read = deferredRead();

    const pending = runPastePlainCommand(read.readText);
    expect(post).not.toHaveBeenCalled();
    read.resolve("plain text\nhttps://example.com");
    await pending;

    expect(post).toHaveBeenCalledExactlyOnceWith({
      protocol: PROTOCOL_VERSION,
      type: "paste-plain",
      text: "plain text\nhttps://example.com",
    });
  });

  it("targets B when the active panel switches from A to B during the read", async () => {
    const postA = vi.fn();
    const postB = vi.fn();
    setActivePanelPost(postA);
    const read = deferredRead();

    const pending = runPastePlainCommand(read.readText);
    setActivePanelPost(postB);
    read.resolve("arrived");
    await pending;

    expect(postA).not.toHaveBeenCalled();
    expect(postB).toHaveBeenCalledExactlyOnceWith({
      protocol: PROTOCOL_VERSION,
      type: "paste-plain",
      text: "arrived",
    });
  });

  it("posts nothing when the active panel is cleared during the read", async () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const read = deferredRead();

    const pending = runPastePlainCommand(read.readText);
    clearActivePanelPost(post);
    read.resolve("arrived");
    await pending;

    expect(post).not.toHaveBeenCalled();
  });

  it("posts nothing for empty clipboard text", async () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const read = deferredRead();

    const pending = runPastePlainCommand(read.readText);
    read.resolve("");
    await pending;

    expect(post).not.toHaveBeenCalled();
  });

  it("shows one error toast and logs a rejected read without posting", async () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const toast = vi.spyOn(window, "showErrorMessage");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("clipboard unavailable");
    const read = deferredRead();

    const pending = runPastePlainCommand(read.readText);
    read.reject(error);
    await pending;

    expect(toast).toHaveBeenCalledExactlyOnceWith("Quoll: could not read the clipboard.");
    expect(log).toHaveBeenCalledExactlyOnceWith("[quoll] could not read the clipboard", error);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts overlapping reads in resolution order", async () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const first = deferredRead();
    const second = deferredRead();

    const firstPending = runPastePlainCommand(first.readText);
    const secondPending = runPastePlainCommand(second.readText);
    second.resolve("second");
    await secondPending;
    first.resolve("first");
    await firstPending;

    expect(post.mock.calls).toEqual([
      [{ protocol: PROTOCOL_VERSION, type: "paste-plain", text: "second" }],
      [{ protocol: PROTOCOL_VERSION, type: "paste-plain", text: "first" }],
    ]);
  });
});

describe("command registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires quoll.pastePlain to runPastePlainCommand", () => {
    const spy = vi.spyOn(commands, "registerCommand");

    registerPastePlainCommand();

    expect(spy).toHaveBeenCalledWith("quoll.pastePlain", runPastePlainCommand);
  });
});
