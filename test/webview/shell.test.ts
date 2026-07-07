// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type HostToWebview, PROTOCOL_VERSION } from "../../src/shared/protocol.js";

// shell.ts integration tests (post C3 React-free shell). Replaces the
// React-era app.test.ts + persistence.test.ts. The shell mounts as a
// plain DOM-level call — no React, no act(), no StrictMode.

const subscribers: Array<(message: HostToWebview) => void> = [];
const sequence: string[] = [];
const postMessage = vi.fn((m: unknown) => {
  const tagged = m as { type?: string };
  sequence.push(`post:${tagged.type ?? "unknown"}`);
});
const subscribeImpl = vi.fn((handler: (message: HostToWebview) => void) => {
  sequence.push("subscribe");
  subscribers.push(handler);
  return () => {
    const i = subscribers.indexOf(handler);
    if (i >= 0) {
      subscribers.splice(i, 1);
    }
  };
});

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: (handler: (message: HostToWebview) => void) => subscribeImpl(handler),
}));

let container: HTMLElement | null = null;
let handle: { dispose(): void } | null = null;

beforeEach(() => {
  subscribers.length = 0;
  sequence.length = 0;
  postMessage.mockReset();
  subscribeImpl.mockClear();
  subscribeImpl.mockImplementation((h: (message: HostToWebview) => void) => {
    sequence.push("subscribe");
    subscribers.push(h);
    return () => {
      const i = subscribers.indexOf(h);
      if (i >= 0) {
        subscribers.splice(i, 1);
      }
    };
  });
  postMessage.mockImplementation((m: unknown) => {
    const tagged = m as { type?: string };
    sequence.push(`post:${tagged.type ?? "unknown"}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (handle) {
    handle.dispose();
    handle = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  // Defensive: even though each timer-using test wraps its body in
  // try/finally + vi.useRealTimers, keep an unconditional cleanup
  // here as belt-and-suspenders. Matches editor.test.ts's afterEach
  // pattern.
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark-theme", "light-theme");
});

async function mount(opts: { resourceBaseUri?: string } = {}): Promise<void> {
  const { mountShell } = await import("../../src/webview/shell.js");
  handle = mountShell(container as HTMLElement, { nonce: "test-nonce", ...opts });
}

function buildDocument(
  overrides: Partial<Extract<HostToWebview, { type: "document" }>> = {}
): HostToWebview {
  return {
    protocol: PROTOCOL_VERSION,
    type: "document",
    content: "",
    docVersion: 1,
    isDarkTheme: false,
    canWrite: true,
    ...overrides,
  };
}

function deliver(message: HostToWebview): void {
  for (const handler of subscribers) {
    handler(message);
  }
}

describe("shell — Ready handshake ordering", () => {
  it("subscribes to host before posting ready", async () => {
    await mount();
    expect(sequence[0]).toBe("subscribe");
    expect(sequence).toContain("post:ready");
    expect(sequence.indexOf("subscribe")).toBeLessThan(sequence.indexOf("post:ready"));
  });

  it("posts ready exactly once (no StrictMode double-mount)", async () => {
    await mount();
    const readyCount = sequence.filter((s) => s === "post:ready").length;
    expect(readyCount).toBe(1);
  });
});

describe("shell — stale Document drop at ingress", () => {
  it("drops a stale Document without re-seeding the editor", async () => {
    // The shell no longer parses (C8), so the old "markdownToProseMirror not
    // called" spy is now vacuous (it is never called for fresh OR stale docs).
    // Pin the load-bearing property directly: a stale Document
    // (docVersion < displayed) must NOT change the editor's displayed content.
    // A direct sliceDoc() comparison — NOT an applyDocument call-spy — is
    // required: applyDocument is reachable via other paths (e.g. a `ready`
    // reseed) so a call-spy could false-pass.
    await mount();
    deliver(buildDocument({ docVersion: 5, content: "current", canWrite: true }));
    deliver(buildDocument({ docVersion: 2, content: "STALE", canWrite: true }));
    const view = EditorView.findFromDOM(container?.querySelector(".quoll-editor") as HTMLElement);
    expect(view?.state.sliceDoc()).toBe("current"); // stale (v2 < v5) ignored — unchanged
  });
});

describe("shell — theme toggles <html> classList", () => {
  it("dark theme → html has dark-theme class", async () => {
    await mount();
    deliver(buildDocument({ docVersion: 1, isDarkTheme: true }));
    expect(document.documentElement.classList.contains("dark-theme")).toBe(true);
    expect(document.documentElement.classList.contains("light-theme")).toBe(false);
  });

  it("theme message flips classes without a new Document", async () => {
    await mount();
    deliver(buildDocument({ docVersion: 1, isDarkTheme: true }));
    deliver({ protocol: PROTOCOL_VERSION, type: "theme", isDarkTheme: false });
    expect(document.documentElement.classList.contains("light-theme")).toBe(true);
    expect(document.documentElement.classList.contains("dark-theme")).toBe(false);
  });

  // The React-era useEffect with [state.theme] dep ran on mount even when
  // the theme had not changed. The vanilla shell applies initialState's
  // theme class at mount time so this never silently regresses.
  it("initialState theme class is applied at mount (before any host message)", async () => {
    await mount();
    // initialState.theme === "dark" → dark-theme is set on <html> from
    // mount, BEFORE any Document arrives.
    expect(document.documentElement.classList.contains("dark-theme")).toBe(true);
  });

  it("same-theme first Document leaves the class set (initial-apply at mount survives same-theme Document)", async () => {
    await mount();
    // initialState.theme === "dark"; first Document also "dark". The
    // dispatch-time syncTheme short-circuits on prev===next, so the
    // initial-apply at mount must carry the class.
    deliver(buildDocument({ docVersion: 1, isDarkTheme: true }));
    expect(document.documentElement.classList.contains("dark-theme")).toBe(true);
    expect(document.documentElement.classList.contains("light-theme")).toBe(false);
  });
});

describe("shell — raw HTML seeds inert (parse-warning coupling retired)", () => {
  const RAW = "<div>raw</div>\n\nbody";
  it("seeds raw HTML verbatim with no blocking banner", async () => {
    await mount();
    deliver(buildDocument({ docVersion: 1, content: RAW, canWrite: true, isDarkTheme: true }));
    const bannerHost = container?.querySelector(".quoll-banner-host") as HTMLElement;
    // (1) No "Save anyway" warning banner, no parse-error banner.
    expect(bannerHost.querySelector("button")).toBeNull();
    expect(bannerHost.textContent ?? "").not.toContain("could not be parsed");
    // (2) The editor actually seeded the raw bytes VERBATIM — not a banner-only
    //     check (Codex r3 #1: a banner-only assertion would still pass if
    //     applyDocument were dropped). Read the mounted CM doc directly.
    const view = EditorView.findFromDOM(container?.querySelector(".quoll-editor") as HTMLElement);
    expect(view?.state.sliceDoc()).toBe(RAW);
  });
});

// NOTE: the init-error surface test (vanilla ErrorBoundary replacement)
// lives in test/webview/index-error.test.ts. It is in a separate file
// so its host mock (getHost throws) does not collide with shell.test.ts's
// baseline host mock; isolation at the file level avoids vi.resetModules
// + vi.doMock + dynamic import interleavings.

function buildEditRejected(
  error: { code: string; message: string } = {
    code: "unsafe_url",
    message: "URL is not in the allowlist: javascript:alert(1)",
  }
): HostToWebview {
  return {
    protocol: PROTOCOL_VERSION,
    type: "edit-rejected",
    error,
  };
}

describe("shell — edit-rejected routing", () => {
  it("renders the serializeError banner with the host's reject message", async () => {
    await mount();
    deliver(buildDocument({ docVersion: 1, content: "hello\n" }));
    deliver(buildEditRejected());
    const banner = (container as HTMLElement).querySelector(".quoll-banner.error");
    expect(banner?.textContent ?? "").toContain("URL is not in the allowlist: javascript:alert(1)");
    // Pin data-code for the known-code path (symmetric with the unknown-code test).
    expect(banner?.getAttribute("data-code")).toBe("unsafe_url");
  });

  it("edit-rejected with an unknown error.code still raises the banner without throwing", async () => {
    // The wire delivers `error.code` typed as plain `string`; a future
    // host shipping a literal this build does not know about (or a
    // malformed message slipping past the boundary validator's
    // `typeof === "string"` check) must NOT crash the shell.
    // `narrowMarkdownErrorCode` falls back to "internal_error" and the
    // banner still renders the host's `error.message` verbatim.
    //
    // The "banner renders" assertion alone would pass even without the
    // narrow (an unsafe cast also reaches the banner), so this test
    // additionally pins the documented fallback by calling
    // `narrowMarkdownErrorCode` directly. Removing the Set/helper and
    // restoring `as MarkdownErrorCode` makes the direct assertion go red.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    deliver(buildDocument({ docVersion: 1, content: "hello\n" }));
    expect(() => {
      deliver(
        buildEditRejected({
          code: "future_unknown_code",
          message: "future host policy",
        })
      );
    }).not.toThrow();
    const banner = (container as HTMLElement).querySelector(".quoll-banner.error");
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toContain("future host policy");
    // No console.error from the shell — the narrow is silent, not noisy.
    const quollErrors = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("[quoll]")
    );
    expect(quollErrors.length).toBe(0);
    consoleSpy.mockRestore();

    // Dispatch-path pin — asserts the shell's edit-rejected arm actually
    // invokes narrowMarkdownErrorCode before dispatching, not just that the
    // helper works in isolation. If shell.ts reverts to
    // `code: message.error.code as MarkdownErrorCode`, the banner's
    // data-code would carry "future_unknown_code" instead of
    // "internal_error" and this assertion goes red.
    // Note: this pin depends on banners.ts writing `err.code` verbatim to
    // data-code. It correctly detects a revert of narrowMarkdownErrorCode in
    // shell.ts because banners.ts is transparent (no code-canonicalization).
    // If banners.ts ever adds defensive code normalization, move the pin to
    // a spy on narrowMarkdownErrorCode or on the dispatch action payload.
    expect(banner?.getAttribute("data-code")).toBe("internal_error");

    // Secondary helper-isolation pin (kept for documentation of the
    // narrowMarkdownErrorCode contract independently of the dispatch wire).
    const { narrowMarkdownErrorCode } = await import("../../src/webview/shell.js");
    expect(narrowMarkdownErrorCode("future_unknown_code")).toBe("internal_error");
  });

  it("user's LOCAL edit survives an edit-rejected (typed bytes are not overwritten)", async () => {
    // The seed delivers disk bytes. The user types via the EditorView
    // (programmatic transaction stands in for a keystroke — happy-dom does
    // not faithfully fire CM input events). Then edit-rejected arrives.
    // The user's typed bytes must STILL be in the editor's doc after the
    // routing: the shell must NOT call editor.applyDocument on
    // edit-rejected, so the editor view holds the user's bytes verbatim.
    await mount();
    deliver(buildDocument({ docVersion: 1, content: "seed body\n" }));

    const mountEl = (container as HTMLElement).querySelector(".quoll-editor") as HTMLElement;
    const view = EditorView.findFromDOM(mountEl);
    if (!view) {
      throw new Error("EditorView not found via findFromDOM");
    }
    // User types " edited" at the end of the doc.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " edited" },
    });
    const docBeforeReject = view.state.sliceDoc();
    expect(docBeforeReject).toContain(" edited");

    deliver(buildEditRejected());

    const docAfterReject = view.state.sliceDoc();
    expect(docAfterReject).toBe(docBeforeReject); // unchanged — user's bytes survived
  });
});

describe("shell — relative image read-path seam (shell → editor → facet)", () => {
  it("resolves a relative image src against the injected resourceBaseUri", async () => {
    // End-to-end passthrough of the read-path spine: mountShell({resourceBaseUri})
    // → mountEditor({resourceBaseUri}) → quollResourceBaseUri.of(...). Both ENDS
    // are covered elsewhere (host emits data-resource-base-uri; imageBlockField
    // resolves when the facet is injected directly); this pins the MIDDLE
    // passthrough. A regression dropping resourceBaseUri from the mountEditor
    // call would leave the facet "" and render the relative image inert with the
    // suite otherwise green.
    await mount({ resourceBaseUri: "https://csp/ws/notes/a.md" });
    // Image on line 3 so the seed caret (position 0) does not reveal it → the
    // block widget (live <img>) is emitted rather than the raw source revealed.
    deliver(buildDocument({ docVersion: 1, content: "text\n\n![d](./img.png)\n" }));
    const img = container?.querySelector("img.quoll-image") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://csp/ws/notes/img.png");
  });
});

describe("shell — KNOWN_MARKDOWN_ERROR_CODES exhaustiveness", () => {
  it("the Set covers every MarkdownErrorCode literal", async () => {
    // The Set powers shell.ts's wire-boundary narrow
    // (`narrowMarkdownErrorCode`). Exhaustiveness is pinned at compile
    // time by `_AllLiteralsCovered` in shell.ts — adding a literal to
    // `MarkdownErrorCode` without extending `MARKDOWN_ERROR_CODE_LITERALS`
    // causes `pnpm compile` to fail with "Type 'false' is not assignable
    // to type 'true'". This runtime test derives its fixture from the
    // same tuple so no parallel hand-maintained list exists.
    const { KNOWN_MARKDOWN_ERROR_CODES, MARKDOWN_ERROR_CODE_LITERALS } = await import(
      "../../src/webview/shell.js"
    );
    for (const literal of MARKDOWN_ERROR_CODE_LITERALS) {
      expect(KNOWN_MARKDOWN_ERROR_CODES.has(literal)).toBe(true);
    }
    // Size invariant: detects extra entries in the Set (the per-literal
    // loop above detects missing entries).
    expect(KNOWN_MARKDOWN_ERROR_CODES.size).toBe(MARKDOWN_ERROR_CODE_LITERALS.length);
  });

  it("narrowMarkdownErrorCode is identity on a known code", async () => {
    const { narrowMarkdownErrorCode } = await import("../../src/webview/shell.js");
    expect(narrowMarkdownErrorCode("unsafe_url")).toBe("unsafe_url");
    expect(narrowMarkdownErrorCode("invalid_frontmatter")).toBe("invalid_frontmatter");
  });

  it("narrowMarkdownErrorCode falls back to internal_error on an unknown code", async () => {
    const { narrowMarkdownErrorCode } = await import("../../src/webview/shell.js");
    expect(narrowMarkdownErrorCode("future_unknown_code")).toBe("internal_error");
    expect(narrowMarkdownErrorCode("")).toBe("internal_error");
  });
});

describe("shell — teardown flush (close-without-save data loss)", () => {
  it("flushes pending content to the host on visibilitychange:hidden (before the debounce fires)", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      deliver(buildDocument({ docVersion: 1, canWrite: true, isDarkTheme: false }));
      const view = EditorView.findFromDOM(container?.querySelector(".quoll-editor") as HTMLElement);
      if (!view) {
        throw new Error("EditorView not found");
      }
      view.dispatch({ changes: { from: 0, insert: "edited" } });
      // Debounce NOT advanced — nothing posted yet on the normal path.
      expect(sequence.filter((s) => s === "post:edit").length).toBe(0);
      // Tab hidden (close / switch-away) → teardown flush posts immediately.
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(sequence.filter((s) => s === "post:edit").length).toBe(1);
      // The posted edit carries the current CM bytes.
      const lastEdit = postMessage.mock.calls
        .map((c) => c[0] as { type?: string; content?: string })
        .reverse()
        .find((m) => m.type === "edit");
      expect(lastEdit?.content).toContain("edited");
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      vi.useRealTimers();
    }
  });

  it("flushes pending content to the host on pagehide", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      deliver(buildDocument({ docVersion: 1, canWrite: true, isDarkTheme: false }));
      const view = EditorView.findFromDOM(container?.querySelector(".quoll-editor") as HTMLElement);
      if (!view) {
        throw new Error("EditorView not found");
      }
      view.dispatch({ changes: { from: 0, insert: "more" } });
      expect(sequence.filter((s) => s === "post:edit").length).toBe(0);
      window.dispatchEvent(new Event("pagehide"));
      expect(sequence.filter((s) => s === "post:edit").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
