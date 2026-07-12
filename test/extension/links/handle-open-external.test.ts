import { describe, expect, it, vi } from "vitest";

import { handleOpenExternal } from "../../../src/extension/links/handle-open-external.js";

function deps() {
  const calls: string[] = [];
  const errors: string[] = [];
  const openExternal = vi.fn(async (url: string): Promise<boolean> => {
    calls.push(url);
    return true;
  });
  const showError = vi.fn((message: string): void => {
    errors.push(message);
  });
  return { calls, errors, openExternal, showError };
}

const FAILURE_TOAST = "Quoll: couldn't open the link. See the extension host log for details.";

describe("handleOpenExternal", () => {
  it("calls openExternal for an allowlisted https URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("https://example.com", { openExternal, showError });
    expect(calls).toEqual(["https://example.com"]);
  });

  it("calls openExternal for an allowlisted http URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("http://example.com", { openExternal, showError });
    expect(calls).toEqual(["http://example.com"]);
  });

  it("calls openExternal for a mailto URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("mailto:a@b.c", { openExternal, showError });
    expect(calls).toEqual(["mailto:a@b.c"]);
  });

  it("does NOT call openExternal for a javascript: URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript:alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a data: URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("data:text/html,<script>alert(1)</script>", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a protocol-relative URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("//evil.example/x", { openExternal, showError });
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
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("\\\\evil.example/x", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a vbscript URL", () => {
    // Webview-side matrix (Task 7) carries this row too — kept symmetric.
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("vbscript:msgbox", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a C0-control bypass", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("java\nscript:alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a trailing-LF C0 bypass (review-cycle 1 C1)", () => {
    // String.prototype.trim() strips trailing \n, so a trim-before-check
    // order would silently let `"https://example.com\n"` through after
    // trim erases the LF. isAllowedUrl now gates the RAW value first,
    // so the trailing LF is caught even though trim would have stripped it.
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("https://example.com\n", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a relative path (relative is allowlist-true but has no scheme to launch)", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("/relative/path", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a fragment-only URL", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("#frag", { openExternal, showError });
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
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript\\:alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a numeric-entity scheme bypass", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript&#58;alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a hex-entity scheme bypass", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript&#x3A;alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a named-entity scheme bypass", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript&colon;alert(1)", { openExternal, showError });
    expect(calls).toEqual([]);
  });

  it("does NOT call openExternal for a surrogate-substitute scheme bypass", () => {
    const { calls, openExternal, showError } = deps();
    handleOpenExternal("javascript&#xD800;:alert(1)", { openExternal, showError });
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
      const { calls, openExternal, showError } = deps();
      handleOpenExternal("/relative/path", { openExternal, showError });
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
      const { calls, openExternal, showError } = deps();
      handleOpenExternal("#frag", { openExternal, showError });
      expect(calls).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[quoll] open-external dropped: scheme not in OPENABLE_SCHEMES",
        expect.objectContaining({ scheme: "(none)" })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT surface a toast when the launch succeeds (fulfilled true)", async () => {
    const { calls, errors, openExternal, showError } = deps();
    handleOpenExternal("https://example.com", { openExternal, showError });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["https://example.com"]);
    expect(errors).toEqual([]);
  });

  it("surfaces a toast when openExternal resolves false (no OS handler for the scheme)", async () => {
    // The core of this task: a fulfilled `false` means the platform found no
    // handler for the URL — previously discarded, giving a failed click zero
    // UI feedback. It must now reach the user via showError.
    const errors: string[] = [];
    const openExternal = vi.fn(async (_url: string): Promise<boolean> => false);
    const showError = vi.fn((message: string): void => {
      errors.push(message);
    });
    handleOpenExternal("https://example.com", { openExternal, showError });
    // showError fires from the .then continuation — flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(showError).toHaveBeenCalledOnce();
    expect(errors).toEqual([FAILURE_TOAST]);
  });

  it("surfaces a toast on openExternal rejection and does not unhandled-reject", async () => {
    const errors: string[] = [];
    const openExternal = vi.fn(async (_url: string): Promise<boolean> => {
      throw new Error("simulated platform failure");
    });
    const showError = vi.fn((message: string): void => {
      errors.push(message);
    });
    // Synchronous call; rejection is consumed inside the handler.
    expect(() =>
      handleOpenExternal("https://example.com", { openExternal, showError })
    ).not.toThrow();
    // Give the microtask queue a tick — assert no unhandled-reject in tests.
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(errors).toEqual([FAILURE_TOAST]);
  });

  it("surfaces a toast on a SYNCHRONOUS openExternal throw — Uri.parse inside deps closure could throw before Promise.resolve runs", () => {
    // Simulates the production wiring `openExternal: (url) => env.openExternal(Uri.parse(url))`
    // where `Uri.parse` (or env.openExternal itself) throws synchronously.
    // Without the try/catch in handleOpenExternal, this throw escapes
    // handleOpenExternal → escapes the `case "open-external"` arm of
    // QuollEditorPanel.handleInbound → breaks the switch and crashes
    // future inbound message handling.
    const errors: string[] = [];
    const openExternal = vi.fn((_url: string): Thenable<boolean> => {
      throw new Error("simulated synchronous throw (e.g. Uri.parse malformed input)");
    });
    const showError = vi.fn((message: string): void => {
      errors.push(message);
    });
    expect(() =>
      handleOpenExternal("https://example.com", { openExternal, showError })
    ).not.toThrow();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(errors).toEqual([FAILURE_TOAST]);
  });
});
