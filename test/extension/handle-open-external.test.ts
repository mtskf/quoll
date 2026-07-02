import { describe, expect, it, vi } from "vitest";

import { handleOpenExternal } from "../../src/extension/handle-open-external.js";

function deps() {
  const calls: string[] = [];
  const openExternal = vi.fn(async (url: string): Promise<boolean> => {
    calls.push(url);
    return true;
  });
  return { calls, openExternal };
}

describe("handleOpenExternal", () => {
  it("calls openExternal for an allowlisted https URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("https://example.com", { openExternal });
    expect(calls).toEqual(["https://example.com"]);
  });

  it("calls openExternal for an allowlisted http URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("http://example.com", { openExternal });
    expect(calls).toEqual(["http://example.com"]);
  });

  it("calls openExternal for a mailto URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("mailto:a@b.c", { openExternal });
    expect(calls).toEqual(["mailto:a@b.c"]);
  });

  it("does NOT call openExternal for a javascript: URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript:alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a data: URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("data:text/html,<script>alert(1)</script>", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a protocol-relative URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("//evil.example/x", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a protocol-relative backslash URL", () => {
    // Webview-side matrix (Task 7) carries this row too — kept symmetric
    // so the DRIFT WARNING invariant (both matrices cover the same
    // hostile-URL attack-scenario set) stays in sync. (Most rows
    // including this one are byte-identical across matrices, but the
    // two C0-bypass rows — inline `java&#10;script:...` and trailing
    // `...example.com&#10;` — deliberately differ: webview passes the
    // raw entity form `&#10;`, this host matrix passes the post-decode
    // literal `\n` per protocol — so the matrices are not byte-identical
    // overall, just attack-equivalent.)
    const { calls, openExternal } = deps();
    handleOpenExternal("\\\\evil.example/x", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a vbscript URL", () => {
    // Webview-side matrix (Task 7) carries this row too — kept symmetric.
    const { calls, openExternal } = deps();
    handleOpenExternal("vbscript:msgbox", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a C0-control bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("java\nscript:alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a trailing-LF C0 bypass (review-cycle 1 C1)", () => {
    // String.prototype.trim() strips trailing \n, so a trim-before-check
    // order would silently let `"https://example.com\n"` through after
    // trim erases the LF. isAllowedUrl now gates the RAW value first,
    // so the trailing LF is caught even though trim would have stripped it.
    const { calls, openExternal } = deps();
    handleOpenExternal("https://example.com\n", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a relative path (relative is allowlist-true but has no scheme to launch)", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("/relative/path", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a fragment-only URL", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("#frag", { openExternal });
    expect(calls).toEqual([]);
  });

  // Encoded-bypass matrix: mirrors the webview-side matrix in
  // test/webview/cm-link-handlers.test.ts.
  // The host receives the POST-DECODE href from the webview (per protocol
  // design), so in normal operation a raw-encoded bypass never reaches
  // here — but defense in depth: if a malicious webview sent the raw form
  // verbatim, the host's `schemeOf` returns null (the `\` or `&` interrupts
  // the scheme regex) and `OPENABLE_SCHEMES.has(null)` is false → no
  // openExternal call. These rows pin that fallthrough.
  it("does NOT call openExternal for a backslash-colon scheme bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript\\:alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a numeric-entity scheme bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript&#58;alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a hex-entity scheme bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript&#x3A;alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a named-entity scheme bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript&colon;alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a surrogate-substitute scheme bypass", () => {
    const { calls, openExternal } = deps();
    handleOpenExternal("javascript&#xD800;:alert(1)", { openExternal });
    expect(calls).toEqual([]);
  });

  // Review-cycle 1 (C3): the DRIFT WARNING header on the source file flags
  // the scheme-not-launchable arm as the place a host/webview gate drift
  // surfaces in production. Previously the arm fell through silently,
  // leaving zero runtime signal. The sibling allowlist-reject arm already
  // console.warns for the same reason — this pins the symmetric warn on
  // the OPENABLE_SCHEMES fallthrough.
  it("logs a drift warning when an allowlist-true URL has an unlaunchable scheme (relative)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { calls, openExternal } = deps();
      handleOpenExternal("/relative/path", { openExternal });
      expect(calls).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[quoll] open-external dropped: scheme not in OPENABLE_SCHEMES",
        expect.objectContaining({ scheme: "(none)" })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs a drift warning when an allowlist-true URL has an unlaunchable scheme (fragment)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { calls, openExternal } = deps();
      handleOpenExternal("#frag", { openExternal });
      expect(calls).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[quoll] open-external dropped: scheme not in OPENABLE_SCHEMES",
        expect.objectContaining({ scheme: "(none)" })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("swallows openExternal rejection so the host arm does not unhandled-reject", async () => {
    const openExternal = vi.fn(async (_url: string): Promise<boolean> => {
      throw new Error("simulated platform failure");
    });
    // Synchronous call; rejection is consumed inside the handler.
    expect(() => handleOpenExternal("https://example.com", { openExternal })).not.toThrow();
    // Give the microtask queue a tick — assert no unhandled-reject in tests.
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("swallows SYNCHRONOUS openExternal throws — Uri.parse inside deps closure could throw before Promise.resolve runs", () => {
    // Simulates the production wiring `openExternal: (url) => env.openExternal(Uri.parse(url))`
    // where `Uri.parse` (or env.openExternal itself) throws synchronously.
    // Without the try/catch in handleOpenExternal, this throw escapes
    // handleOpenExternal → escapes the `case "open-external"` arm of
    // QuollEditorPanel.handleInbound → breaks the switch and crashes
    // future inbound message handling.
    const openExternal = vi.fn((_url: string): Thenable<boolean> => {
      throw new Error("simulated synchronous throw (e.g. Uri.parse malformed input)");
    });
    expect(() => handleOpenExternal("https://example.com", { openExternal })).not.toThrow();
    expect(openExternal).toHaveBeenCalledOnce();
  });
});
