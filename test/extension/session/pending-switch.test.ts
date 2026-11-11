import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window, workspace } from "vscode";
import { QuollEditorPanel } from "../../../src/extension/session/quoll-editor-panel.js";
import { getActiveSwitchPoster } from "../../../src/extension/surface/switch-poster.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

vi.mock("vscode", async (importOriginal) => {
  const stub = await importOriginal<typeof import("../../vscode-stub.js")>();
  const event = () => ({ dispose() {} });
  return {
    ...stub,
    StatusBarAlignment: { Right: 2 },
    Disposable: {
      from: (...items: Array<{ dispose(): void }>) => ({
        dispose: () =>
          items.forEach((i) => {
            i.dispose();
          }),
      }),
    },
    window: { ...stub.window, activeColorTheme: { kind: 1 }, onDidChangeActiveColorTheme: event },
    workspace: { ...stub.workspace, onDidChangeTextDocument: event },
  };
});

function setup(sendResult = true) {
  let inbound!: (message: unknown) => void;
  let dispose!: () => void;
  const sent: string[] = [];
  const uri = { scheme: "untitled", fsPath: "/draft.md", toString: () => "untitled:draft.md" };
  const document = {
    uri,
    version: 1,
    eol: 1,
    languageId: "markdown",
    isDirty: true,
    getText: () => "unsynced draft",
    save: vi.fn(),
  };
  const panel = {
    active: true,
    visible: true,
    webview: {
      postMessage: vi.fn((m: { type: string }) => {
        sent.push(m.type);
        return Promise.resolve(sendResult);
      }),
      onDidReceiveMessage: (cb: typeof inbound) => {
        inbound = cb;
        return { dispose() {} };
      },
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: (cb: () => void) => {
      dispose = cb;
    },
  };
  const slot = () => ({ show() {}, hide() {}, dispose() {} });
  const harness = {
    buildWebviewHtmlOverride: () => "",
    newStatusBarItem: slot,
    recordEvent: vi.fn(),
    recordInbound: vi.fn(),
    setActivePanel: vi.fn(),
    recordError: vi.fn(),
  };
  const provider = new QuollEditorPanel(
    { extensionUri: { path: "/extension" }, subscriptions: [] } as never,
    harness as never
  );
  provider.resolveCustomTextEditor(document as never, panel as never, {} as never);
  return {
    inbound,
    dispose,
    sent,
    document,
    request: () => getActiveSwitchPoster()?.(uri.toString()),
  };
}

describe("pending switch startup notice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("warns once at the original deadline while retaining the switch and unsynced edits", () => {
    const warning = vi.spyOn(window, "showWarningMessage");
    const apply = vi.spyOn(workspace, "applyEdit");
    const execute = vi.spyOn(commands, "executeCommand");
    const s = setup(false);
    s.request();
    vi.advanceTimersByTime(4999);
    s.request();
    expect(warning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/not finished starting/i));
    s.request();
    vi.advanceTimersByTime(10000);
    expect(warning).toHaveBeenCalledOnce();
    expect(s.document.save).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(s.sent.filter((t) => t === "switch-command")).toHaveLength(0);
    s.inbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    s.inbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    expect(s.sent.filter((t) => t === "switch-command")).toHaveLength(1);
    s.dispose();
  });
  it.each(["ready", "dispose"])("cancels notice on %s", (event) => {
    const warning = vi.spyOn(window, "showWarningMessage");
    const s = setup();
    s.request();
    if (event === "ready") {
      s.inbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    } else {
      s.dispose();
    }
    vi.advanceTimersByTime(5000);
    expect(warning).not.toHaveBeenCalled();
    if (event === "ready") {
      s.dispose();
    }
  });
});
