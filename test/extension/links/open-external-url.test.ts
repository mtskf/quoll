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

  it.each([
    "mailto:person@example.com?subject=a%26b",
    "http://localhost%2F@evil.example/x",
    "http://user@example.com/",
    "http://[::1]:9/x",
    "http://localhost\\path",
    "https://",
  ])("uses env.openExternal for local %s", async (href) => {
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

  it.each([
    "HTTP://example.com/a%2Fb",
    "https://localhost:9/a%2Fb?q=x+y#z",
    "https://localhost:9?q=a%26b",
    "https://localhost:9#section%20one",
  ])("opens local %s with the original string", async (href) => {
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
