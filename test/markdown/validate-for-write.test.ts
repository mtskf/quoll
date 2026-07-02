import { describe, expect, it, vi } from "vitest";

import { validateMarkdownForWrite } from "../../src/markdown/validate-for-write.js";

describe("validateMarkdownForWrite", () => {
  it("returns ok for benign markdown", () => {
    const result = validateMarkdownForWrite("# hello\n");
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with code 'unsafe_url' for a javascript: link", () => {
    // The Lezer walker rejects javascript: hrefs via isAllowedUrl.
    // Full URL-form matrix coverage lives in validate-for-write-matrix.test.ts.
    const result = validateMarkdownForWrite("[link](javascript:alert(1))\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsafe_url");
    }
  });

  it("returns ok=false with code 'internal_error' when the walker throws", async () => {
    // Defense in depth: the Lezer parser is expected to handle any
    // input, but stack overflow on adversarially nested input or a
    // future regression could throw. Use vi.doMock to simulate a throw
    // and assert the verdict surface. Without this guard, the throw
    // would propagate through decideEdit / onDidReceiveMessage and
    // leave the webview frozen with editInFlight=true.
    //
    // Ordering: resetModules() BEFORE doMock() so the gate file's
    // cached binding for `findUnsafeUrl` is invalidated; the dynamic
    // import after doMock then re-binds against the mock. Reversed
    // ordering would leave the cached (real) binding live.
    vi.resetModules();
    vi.doMock("../../src/markdown/lezer-url-walker.js", () => ({
      findUnsafeUrl: () => {
        throw new Error("boom");
      },
    }));
    try {
      const { validateMarkdownForWrite: validateUnderMock } = await import(
        "../../src/markdown/validate-for-write.js"
      );
      const result = validateUnderMock("# anything\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("internal_error");
        // The new message prefix is "Markdown validation failed:" (capped
        // and sanitized — see validate-for-write.ts INTERNAL_ERR_MESSAGE_CAP).
        // The raw "boom" string is short enough to survive the cap.
        expect(result.error.message).toContain("boom");
        expect(result.error.message).toMatch(/^Markdown validation failed:/);
      }
    } finally {
      // Cleanup MUST run even on assertion failure — otherwise the
      // mock leaks to subsequent tests in the same file.
      vi.doUnmock("../../src/markdown/lezer-url-walker.js");
      vi.resetModules();
    }
  });

  it("caps the internal_error message at exactly PREFIX + 200 chars so adversarial inputs cannot bloat the toast", async () => {
    vi.resetModules();
    const longTail = "X".repeat(500);
    vi.doMock("../../src/markdown/lezer-url-walker.js", () => ({
      findUnsafeUrl: () => {
        throw new Error(longTail);
      },
    }));
    try {
      const { validateMarkdownForWrite: validateUnderMock } = await import(
        "../../src/markdown/validate-for-write.js"
      );
      const result = validateUnderMock("# x\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Pin EXACTLY: prefix `"Markdown validation failed: "` (28 chars)
        // + first 200 chars of err.message. A `toBeLessThanOrEqual` with
        // slack let a drifted CAP (e.g. 204 with prefix 28 → total 232
        // still ≤ 232) pass silently, and gave no lower bound.
        const PREFIX = "Markdown validation failed: ";
        expect(result.error.message).toBe(`${PREFIX}${"X".repeat(200)}`);
        expect(result.error.message.length).toBe(PREFIX.length + 200);
      }
    } finally {
      vi.doUnmock("../../src/markdown/lezer-url-walker.js");
      vi.resetModules();
    }
  });

  it("accepts a doc with valid leading frontmatter", () => {
    const result = validateMarkdownForWrite("---\ntitle: x\n---\n\n# Body\n");
    expect(result.ok).toBe(true);
  });

  it("accepts a doc whose leading `---` has no closer (treated as <hr> + prose)", () => {
    // CommonMark behavior: an orphan `---` opener is a thematic break,
    // not malformed frontmatter. The write-gate must accept it so files
    // starting with `<hr>` round-trip.
    const result = validateMarkdownForWrite("---\n\n# heading\n");
    expect(result.ok).toBe(true);
  });

  // The mocked-throw tests above pin the WIRING of the `internal_error`
  // catch arm. The two smoke tests below exercise the EFFICACY claim
  // baked into the catch's existence: deeply-nested adversarial input
  // and 1-MiB-scale documents must either be handled by the parser OR
  // surface as `internal_error` — what is NOT acceptable is a thrown
  // exception (which would freeze the webview) or a silent fail-open.
  it("does not throw on deeply nested link/image structures (parser or safety-net handles it)", () => {
    const DEPTH = 1000;
    let nested = "leaf";
    for (let i = 0; i < DEPTH; i++) {
      nested = `[${nested}](https://example.com/${i})`;
    }
    const source = `${nested}\n`;
    expect(() => validateMarkdownForWrite(source)).not.toThrow();
    const result = validateMarkdownForWrite(source);
    // Either shape is acceptable: parser handled it (ok: true) OR the
    // safety net caught a parser blow-up (`internal_error`). The forbidden
    // shapes are a thrown exception (covered by the not.toThrow above)
    // and a verdict that classifies adversarial input as a different
    // policy violation (e.g. `unsafe_url`) — `unsafe_url` would only fire
    // on `javascript:` etc., which this input doesn't carry.
    if (!result.ok) {
      expect(result.error.code).toBe("internal_error");
    }
  });

  it("validates a ~1 MiB document of benign links without throwing or hanging", () => {
    const ONE_LINK = "[t](https://example.com/x)\n";
    const COPIES = Math.ceil((1 << 20) / ONE_LINK.length);
    const src = ONE_LINK.repeat(COPIES);
    expect(() => validateMarkdownForWrite(src)).not.toThrow();
    const result = validateMarkdownForWrite(src);
    // STRICT: benign 1-MiB content MUST round-trip as ok. Accepting
    // `internal_error` here would mask a regression class where a
    // future parser change throws on large inputs — the catch arm at
    // validate-for-write.ts converts every throw to `internal_error`,
    // the smoke test would stay green, and every user save of a
    // moderately-sized file would surface an error toast in real use.
    // The catch-arm wiring is already pinned by the mocked-throw
    // tests above; this test pins the EFFICACY claim — the parser
    // actually handles benign 1-MiB documents.
    expect(result.ok).toBe(true);
  }, 15_000);
});
