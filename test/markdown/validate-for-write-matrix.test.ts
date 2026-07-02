// URL-form fail-closed matrix. Each row carries an unsafe URL in a
// different Markdown URL form; every row must produce a `parse-failed`-style
// `{ ok: false, error.code: "unsafe_url" }` from validateMarkdownForWrite.
// All rows run against the Lezer walker — including standalone unused
// reference definitions and NUL-bearing destinations, both of which a
// gate that walks the resolved mdast (rather than the raw source slice)
// fails open on. See the dedicated NUL block below for the
// byte-substitution rationale.
import { describe, expect, it, vi } from "vitest";

import { validateMarkdownForWrite } from "../../src/markdown/validate-for-write.js";

// `java\u0000script:alert(1)` lives in a dedicated describe block at
// the bottom of this file rather than inside UNSAFE_SCHEMES. A gate
// that walks the resolved mdast fails open here: micromark replaces
// NUL with U+FFFD (CommonMark §2.3), and the resulting
// `java\uFFFDscript:alert(1)` slips past `isAllowedUrl` (U+FFFD is
// outside the C0/DEL regex; the scheme regex stops at the replacement
// char, fails to find `:`, classifies the URL as a relative path ->
// accepted). The Lezer walker `content.slice`s the raw source bytes,
// preserving the literal NUL, so `isAllowedUrl`'s C0 check rejects.
const UNSAFE_SCHEMES = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "//evil.example.com/x",
];

function expectUnsafe(input: string, label: string): void {
  const result = validateMarkdownForWrite(input);
  if (result.ok) {
    throw new Error(
      `Expected ${label} to be rejected, but it was accepted: ${JSON.stringify(input)}`
    );
  }
  expect(result.error.code).toBe("unsafe_url");
}

describe("URL-form fail-closed matrix", () => {
  describe.each(UNSAFE_SCHEMES)("for %s", (url) => {
    it(`rejects inline link [t](${url})`, () => {
      expectUnsafe(`[t](${url})\n`, "inline link");
    });

    it(`rejects inline image ![a](${url})`, () => {
      expectUnsafe(`![a](${url})\n`, "inline image");
    });

    it(`rejects autolink <${url}>`, () => {
      // Some unsafe values don't form valid autolink syntax. CommonMark
      // §6.4 forbids `<`, `>`, and whitespace inside `<...>` autolinks;
      // a value without a scheme (e.g. `//host`) also cannot be an
      // autolink. For those, CommonMark produces no autolink at all and
      // there is no URL node for the gate to reject by *this* row.
      // The same value is still gated by every other URL-form row above.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        return; // not a valid autolink shape (no scheme)
      }
      if (/[<>\s]/.test(url)) {
        return; // CommonMark §6.4 — autolinks forbid `<`, `>`, whitespace
      }
      expectUnsafe(`<${url}>\n`, "autolink");
    });

    it(`rejects shortcut reference link [t] with [t]: ${url}`, () => {
      expectUnsafe(`[t]\n\n[t]: ${url}\n`, "shortcut reference");
    });

    it(`rejects collapsed reference link [t][] with [t]: ${url}`, () => {
      expectUnsafe(`[t][]\n\n[t]: ${url}\n`, "collapsed reference");
    });

    it(`rejects full reference link [t][id] with [id]: ${url}`, () => {
      expectUnsafe(`[t][id]\n\n[id]: ${url}\n`, "full reference");
    });

    it(`rejects reference image ![t][id] with [id]: ${url}`, () => {
      expectUnsafe(`![t][id]\n\n[id]: ${url}\n`, "reference image");
    });

    it(`rejects URL inside a table cell`, () => {
      const src = `| h |\n| - |\n| [t](${url}) |\n`;
      expectUnsafe(src, "in-table-cell link");
    });

    // The walker iterates every `LinkReference` definition's URL, not
    // just those referenced by a use-site. A standalone *unused*
    // `[ref]: javascript:alert(1)` therefore lands on disk only if its
    // URL passes the allowlist, regardless of whether anything resolves
    // to it. A gate that validates only at the use-site fails open on
    // this shape.
    it(`rejects standalone unused reference definition [unused]: ${url}`, () => {
      expectUnsafe(`# Body\n\n[unused]: ${url}\n`, "unused definition");
    });
  });

  it("rejects an unsafe URL on a multi-word definition regardless of label form", () => {
    // Walker post-revision-3 has NO use-site reference resolver — the
    // definition's URL is gated directly by the `LinkReference` arm,
    // independent of how the use-site `[foo bar]` is spelled or
    // normalized. This row pins definition-gating on a use-site +
    // multi-word-label combination that would have exercised label
    // normalization had a resolver existed.
    expectUnsafe(
      "[foo bar][Foo  Bar]\n\n[Foo  Bar]: javascript:alert(1)\n",
      "definition with multi-word label"
    );
  });
});

describe("URL-form fail-closed matrix — CommonMark destination decoding", () => {
  // The raw Lezer URL slice is the source bytes between the delimiters,
  // NOT the CommonMark-normalized destination. Without
  // decodeMarkdownDestination(), these rows pass the destination through
  // to isAllowedUrl with scheme-obscuring text and fail OPEN. These are
  // the C2 core attack surfaces — every row MUST reject.

  it("rejects an angle-bracketed inline link [t](<javascript:alert(1)>)", () => {
    expectUnsafe("[t](<javascript:alert(1)>)\n", "angle-bracket inline link");
  });

  it("rejects an angle-bracketed inline image ![a](<javascript:alert(1)>)", () => {
    expectUnsafe("![a](<javascript:alert(1)>)\n", "angle-bracket inline image");
  });

  it("rejects an angle-bracketed reference definition [id]: <javascript:alert(1)>", () => {
    // The Lezer URL slice for an angle-bracketed definition destination
    // includes the angle brackets. decodeMarkdownDestination must strip
    // them before the predicate runs.
    expectUnsafe("[t][id]\n\n[id]: <javascript:alert(1)>\n", "angle-bracket reference definition");
  });

  it("rejects a backslash-escaped scheme [t](javascript\\:alert(1))", () => {
    // CommonMark §2.4: any ASCII punctuation can be backslash-escaped
    // and the escape is removed during interpretation. The raw slice
    // retains `\\:` which the scheme regex misses. decodeMarkdownDestination
    // must unescape before the predicate runs.
    expectUnsafe("[t](javascript\\:alert(1))\n", "backslash-escaped colon");
  });

  it("rejects a character-reference scheme [t](javascript&#58;alert(1))", () => {
    // CommonMark §6.2: numeric (`&#58;`) and named (`&colon;`)
    // character references in URL destinations are decoded during
    // interpretation. The raw slice retains `&#58;` which the scheme
    // regex misses. decodeMarkdownDestination must decode references
    // before the predicate runs.
    expectUnsafe("[t](javascript&#58;alert(1))\n", "numeric character reference");
  });

  it("rejects a named-entity scheme [t](javascript&colon;alert(1))", () => {
    expectUnsafe("[t](javascript&colon;alert(1))\n", "named character reference");
  });
});

describe("URL-form fail-closed matrix — decoding × non-inline forms", () => {
  // The inline `[t](url)` cases above pin destination decoding on
  // inline links. Reference DEFINITIONS, image references, and
  // table-cell links flow through the SAME decoder via the
  // `LinkReference` arm, so an asymmetric refactor (e.g. moving decode
  // into a shared helper but skipping it on definitions) would slip past
  // the inline-only rows. This block crosses 4 decorator forms ×
  // 5 non-inline URL forms to pin the symmetry.
  const DECORATED_UNSAFE = [
    ["numeric char ref", "javascript&#58;alert(1)"],
    ["named char ref", "javascript&colon;alert(1)"],
    ["backslash escape", "javascript\\:alert(1)"],
    ["uppercase hex", "javascript&#X3A;alert(1)"],
  ] as const;

  describe.each(DECORATED_UNSAFE)("with %s decoration: %s", (_label, url) => {
    it("rejects shortcut reference", () => {
      expectUnsafe(`[t]\n\n[t]: ${url}\n`, "shortcut reference");
    });

    it("rejects collapsed reference", () => {
      expectUnsafe(`[t][]\n\n[t]: ${url}\n`, "collapsed reference");
    });

    it("rejects full reference", () => {
      expectUnsafe(`[t][id]\n\n[id]: ${url}\n`, "full reference");
    });

    it("rejects image reference", () => {
      expectUnsafe(`![t][id]\n\n[id]: ${url}\n`, "reference image");
    });

    it("rejects in-table-cell link", () => {
      expectUnsafe(`| h |\n| - |\n| [t](${url}) |\n`, "in-table-cell link");
    });
  });
});

describe("URL-form fail-closed matrix — NUL-bearing destinations (raw-source slice preserves NUL so the C0 check rejects)", () => {
  // CommonMark §2.3 mandates that micromark replace NUL (U+0000) in
  // input with U+FFFD before parsing. A gate that walks the resolved
  // mdast therefore sees `java\uFFFDscript:alert(1)` rather than the
  // literal `java\u0000script:alert(1)`. `isAllowedUrl`'s C0/DEL regex
  // (`[\u0000-\u001f\u007f]`) does NOT cover U+FFFD; the scheme regex
  // then matches `j` + `ava`, hits the replacement char, fails to find
  // `:`, and the URL is classified as a relative path -> accepted.
  // The Lezer walker takes the raw source slice with the literal NUL
  // preserved, at which point the C0 check rejects it.
  const NUL_URL = "java\u0000script:alert(1)";

  it("rejects inline link with NUL-bearing URL", () => {
    expectUnsafe(`[t](${NUL_URL})\n`, "inline link (NUL)");
  });

  it("rejects inline image with NUL-bearing URL", () => {
    expectUnsafe(`![a](${NUL_URL})\n`, "inline image (NUL)");
  });

  it("rejects shortcut reference with NUL-bearing definition", () => {
    expectUnsafe(`[t]\n\n[t]: ${NUL_URL}\n`, "shortcut reference (NUL)");
  });

  it("rejects collapsed reference with NUL-bearing definition", () => {
    expectUnsafe(`[t][]\n\n[t]: ${NUL_URL}\n`, "collapsed reference (NUL)");
  });

  it("rejects full reference with NUL-bearing definition", () => {
    expectUnsafe(`[t][id]\n\n[id]: ${NUL_URL}\n`, "full reference (NUL)");
  });

  it("rejects reference image with NUL-bearing definition", () => {
    expectUnsafe(`![t][id]\n\n[id]: ${NUL_URL}\n`, "reference image (NUL)");
  });

  it("rejects URL inside a table cell with NUL-bearing URL", () => {
    expectUnsafe(`| h |\n| - |\n| [t](${NUL_URL}) |\n`, "in-table-cell link (NUL)");
  });
});

describe("raw HTML (Option A) — outside the URL-form contract", () => {
  it.each([
    ["raw HTML <a> with javascript: href", 'Click <a href="javascript:alert(1)">here</a>.\n'],
    ["raw HTML <img> with javascript: src", 'Hello <img src="javascript:alert(1)" alt="x">.\n'],
    ["raw HTML block <script>", "Before.\n\n<script>alert(1)</script>\n\nAfter.\n"],
    [
      "raw HTML <iframe> with data: src",
      'Embed <iframe src="data:text/html,<script>"></iframe>.\n',
    ],
  ])("accepts %s (write-gate does NOT extract attribute URLs)", (_label, input) => {
    const result = validateMarkdownForWrite(input);
    expect(result.ok).toBe(true);
  });

  it("does not mutate raw-HTML input bytes (validator is pure)", () => {
    // The validator is a boolean check — it must not transform its
    // argument. The webview sends raw HTML to the host verbatim; the
    // host persists it verbatim. C4's render-gate (not C2's validator)
    // is what keeps it inert.
    const source = "Before.\n\n<script>alert(1)</script>\n\nAfter.\n";
    const before = source;
    validateMarkdownForWrite(source);
    expect(source).toBe(before);
  });
});

describe("frontmatter detection across line endings", () => {
  it("accepts valid LF frontmatter", () => {
    expect(validateMarkdownForWrite("---\ntitle: x\n---\n\n# Body\n").ok).toBe(true);
  });

  it("accepts valid CRLF frontmatter", () => {
    expect(validateMarkdownForWrite("---\r\ntitle: x\r\n---\r\n\r\n# Body\r\n").ok).toBe(true);
  });

  it("accepts a CRLF frontmatter whose body contains `---` inline as a YAML value", () => {
    // `separator: ---` is a YAML `key: value` line, NOT a bare-fence
    // line per `/^---[ \t]*\r?$/` — validateFrontmatter must accept it.
    // This row pins the CRLF path through the indexOf-based scanner:
    // the body is sliced correctly across `\r\n` line endings and
    // arrives at validateFrontmatter intact. (The CRLF off-by-one in
    // the original split-based implementation produced a body that
    // INCLUDED a trailing `\r`, which would not flip the regex outcome
    // here — both the buggy and fixed versions accept this input. The
    // hygienic fix matters for downstream consumers that compare body
    // bytes; for write-gate validation it is contract-preserving.)
    expect(
      validateMarkdownForWrite(
        "---\r\ntitle: triple-dashes ahead\r\nseparator: ---\r\n---\r\n\r\n# Body\r\n"
      ).ok
    ).toBe(true);
  });

  it("rejects an invalid frontmatter body when the body validator says so (defense-in-depth wiring pin)", async () => {
    // The `invalid_frontmatter` branch is practically unreachable on
    // real input — under correct line-by-line slicing the body cannot
    // contain a bare `---` line (the scanner closes at the FIRST `---`
    // line, so the body ends before any internal bare-fence appears).
    // Mocking validateFrontmatter is the only way to PIN that the
    // wiring is intact: the orchestrator calls it, and a false return
    // surfaces as `invalid_frontmatter`.
    vi.resetModules();
    vi.doMock("../../src/markdown/frontmatter.js", async (orig) => {
      const real = (await orig()) as typeof import("../../src/markdown/frontmatter.js");
      return {
        ...real,
        validateFrontmatter: () => false,
      };
    });
    try {
      const { validateMarkdownForWrite: validateUnderMock } = await import(
        "../../src/markdown/validate-for-write.js"
      );
      const result = validateUnderMock("---\ntitle: x\n---\n\n# Body\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_frontmatter");
      }
    } finally {
      // Cleanup MUST run even when an assertion above throws; otherwise
      // the mock leaks to the next test.
      vi.doUnmock("../../src/markdown/frontmatter.js");
      vi.resetModules();
    }
  });

  it("accepts a leading `---` thematic break with no closer (NOT frontmatter)", () => {
    // CommonMark: orphan `---` opener is a `<hr>`. The gate must NOT
    // reject — files that legitimately start with `<hr>` must
    // round-trip.
    expect(validateMarkdownForWrite("---\n\n# heading\n").ok).toBe(true);
  });

  it("rejects invalid CRLF frontmatter — pins that the CRLF body reaches validateFrontmatter", async () => {
    // Pins that the CRLF opener regex (`/^---[ \t]*\r?\n/`) matches and
    // hands the CRLF body off to validateFrontmatter. If `\r?` is
    // dropped from OPENER, the regex no longer matches CRLF input, the
    // gate returns null without calling validateFrontmatter, and this
    // test would fail open (`ok: true`). The mock forces
    // validateFrontmatter to fail; reaching this branch with CRLF input
    // proves the CRLF code path is alive end-to-end.
    vi.resetModules();
    vi.doMock("../../src/markdown/frontmatter.js", async (orig) => {
      const real = (await orig()) as typeof import("../../src/markdown/frontmatter.js");
      return {
        ...real,
        validateFrontmatter: () => false,
      };
    });
    try {
      const { validateMarkdownForWrite: validateUnderMock } = await import(
        "../../src/markdown/validate-for-write.js"
      );
      const result = validateUnderMock("---\r\ntitle: x\r\n---\r\n\r\n# Body\r\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_frontmatter");
      }
    } finally {
      vi.doUnmock("../../src/markdown/frontmatter.js");
      vi.resetModules();
    }
  });
});
