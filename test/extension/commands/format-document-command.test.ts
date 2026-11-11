import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  clearActivePanelPost,
  getActivePanelPost,
  setActivePanelPost,
} from "../../../src/extension/commands/active-panel.js";
import {
  registerFormatDocumentCommand,
  runFormatDocumentCommand,
} from "../../../src/extension/commands/format-document-command.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

describe("runFormatDocumentCommand — the arm that used to be silent", () => {
  afterEach(() => {
    const active = getActivePanelPost();
    if (active !== null) {
      clearActivePanelPost(active);
    }
    vi.restoreAllMocks();
  });

  it("forwards to the active panel without a toast", () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatDocumentCommand();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ protocol: PROTOCOL_VERSION, type: "format-document" });
    expect(info).not.toHaveBeenCalled();
  });

  it("explains itself when no Quoll panel is active", () => {
    // Palette-only command: invoking it from a text editor (or with no editor
    // at all) used to be `registry.get()?.()` — a silent no-op.
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatDocumentCommand();

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/Quoll/);
  });
});

describe("command registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires quoll.formatDocument to runFormatDocumentCommand", () => {
    // Palette-only command: this id is the single string standing between the
    // package.json contribution and the handler.
    const spy = vi.spyOn(commands, "registerCommand");

    registerFormatDocumentCommand();

    expect(spy).toHaveBeenCalledWith("quoll.formatDocument", runFormatDocumentCommand);
  });
});
