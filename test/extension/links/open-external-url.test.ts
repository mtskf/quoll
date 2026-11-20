import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../../../src/extension/links/open-external-url.js";
import { commands, env } from "../vscode-stub";

vi.mock("../../../src/extension/links/build-external-uri.js", () => ({
  buildExternalUri: (h: string) => ({ built: h }),
}));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.spyOn(env, "openExternal").mockResolvedValue(false);
    vi.spyOn(commands, "executeCommand");
  });

  afterEach(() => {
    env.remoteName = undefined;
    vi.restoreAllMocks();
  });

  it("opens local mailto links with env.openExternal", async () => {
    const href = "mailto:person@example.com?subject=a%26b";

    expect(await openExternalUrl(href)).toBe(false);
    expect(env.openExternal).toHaveBeenCalledExactlyOnceWith({ built: href });
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("opens remote https links with env.openExternal", async () => {
    env.remoteName = "ssh-remote";
    const href = "https://example.com/a%2Fb";

    expect(await openExternalUrl(href)).toBe(false);
    expect(env.openExternal).toHaveBeenCalledExactlyOnceWith({ built: href });
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("opens local HTTP links with the original string", async () => {
    const href = "HTTP://example.com/a%2Fb";

    expect(await openExternalUrl(href)).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledExactlyOnceWith("vscode.open", href);
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  it("propagates a rejected vscode.open command", async () => {
    const href = "https://example.com/x";
    const err = new Error("command failed");
    vi.mocked(commands.executeCommand).mockRejectedValueOnce(err);

    await expect(openExternalUrl(href)).rejects.toBe(err);
    expect(env.openExternal).not.toHaveBeenCalled();
  });
});
