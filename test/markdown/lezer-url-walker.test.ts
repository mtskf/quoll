import { describe, expect, it } from "vitest";

import { findUnsafeUrl } from "../../src/markdown/lezer-url-walker.js";

describe("lezer-url-walker: findUnsafeUrl", () => {
  it("returns null for benign markdown", () => {
    expect(findUnsafeUrl("# hi\n\n[ok](https://example.com)\n")).toBeNull();
  });

  it("accepts benign multi-parameter query strings (no spurious entity decoding)", () => {
    // Named-entity decoding must require a trailing `;`. A
    // semicolon-optional named-entity arm would match any `&word` byte
    // sequence in a URL — including ordinary query-string parameters
    // whose name is not a known entity — and substitute NUL, which the
    // C0 check would then reject as `unsafe_url`. These four shapes
    // (multi-param, hash-anchored, utm-style) all carry benign `&`-
    // separated parameters and MUST round-trip as null.
    expect(findUnsafeUrl("[t](https://example.com/?foo=1&id=2)\n")).toBeNull();
    expect(findUnsafeUrl("[t](https://example.com/?q=x&page=2)\n")).toBeNull();
    expect(findUnsafeUrl("[t](https://example.com/path#section&note)\n")).toBeNull();
    expect(findUnsafeUrl("[t](https://example.com/?utm_source=x&utm_medium=y)\n")).toBeNull();
  });

  it("returns unsafe_url error for an inline javascript: link", () => {
    const err = findUnsafeUrl("[t](javascript:alert(1))\n");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("unsafe_url");
  });

  // Nested image-in-link is CommonMark-legal (the clickable-image idiom).
  // The walker must visit BOTH the inner image's destination AND the
  // outer link's destination — a regression that early-exits the cursor
  // when entering a Link subtree (an easy "optimization") would silently
  // fail-open on the inner image URL.
  it("rejects a NESTED image inside a link when only the image's URL is unsafe", () => {
    expect(findUnsafeUrl("[![alt](javascript:alert(1))](https://example.com)\n")?.code).toBe(
      "unsafe_url"
    );
  });

  it("rejects when only the outer link URL is unsafe (sanity: walker still gates the outer)", () => {
    expect(
      findUnsafeUrl("[![alt](https://example.com/img.png)](javascript:alert(1))\n")?.code
    ).toBe("unsafe_url");
  });

  // Reference USE-SITES (shortcut / collapsed / full / image-reference) are
  // gated indirectly: the destination lives on the `LinkReference`
  // definition, which the walker validates exhaustively. The tests below
  // pin "the gate catches the definition" — they do NOT pin reference
  // resolution (the walker has no resolver). A use-site with no matching
  // definition has no URL to gate; that case is pinned in the
  // "unresolved reference" test further down.

  it("rejects via definition when a shortcut [t] points at javascript:", () => {
    const err = findUnsafeUrl("[t]\n\n[t]: javascript:alert(1)\n");
    expect(err?.code).toBe("unsafe_url");
  });

  it("rejects via definition when a full reference [t][id] points at javascript:", () => {
    const err = findUnsafeUrl("[t][id]\n\n[id]: javascript:alert(1)\n");
    expect(err?.code).toBe("unsafe_url");
  });

  it("rejects via definition when an image reference ![t][id] points at javascript:", () => {
    const err = findUnsafeUrl("![t][id]\n\n[id]: javascript:alert(1)\n");
    expect(err?.code).toBe("unsafe_url");
  });

  it("catches an autolink javascript:", () => {
    const err = findUnsafeUrl("<javascript:alert(1)>\n");
    expect(err?.code).toBe("unsafe_url");
  });

  it("catches a URL inside a table cell", () => {
    const src = "| h |\n| - |\n| [t](javascript:alert(1)) |\n";
    expect(findUnsafeUrl(src)?.code).toBe("unsafe_url");
  });

  it("catches a standalone UNUSED definition (closes the PM gate fail-open hole)", () => {
    expect(findUnsafeUrl("# Body\n\n[unused]: javascript:alert(1)\n")?.code).toBe("unsafe_url");
  });

  it("rejects a SHADOWED duplicate definition (every definition is gated, not just the first-resolved)", () => {
    // CommonMark §4.7 resolves use-sites first-wins, so the use-site
    // `[a]` would resolve to the SAFE first definition. But the
    // shadowed second definition's bytes still land on disk; the gate
    // validates every `LinkReference` block exhaustively.
    expect(findUnsafeUrl("[a]\n\n[a]: https://example.com\n[a]: javascript:alert(1)\n")?.code).toBe(
      "unsafe_url"
    );
  });

  it("accepts two SAFE duplicate definitions (gate is per-definition, not de-duped)", () => {
    expect(
      findUnsafeUrl("[a]\n\n[a]: https://first.example.com\n[a]: https://second.example.com\n")
    ).toBeNull();
  });

  it("accepts a use-site with no matching definition (nothing renders, nothing to gate)", () => {
    // `[orphan]` with no `[orphan]: ...` definition renders as plain
    // text per CommonMark. No URL exists, so the walker has nothing to
    // gate and must NOT spuriously reject.
    expect(findUnsafeUrl("[orphan] use-site with no def\n")).toBeNull();
  });

  // ---- CommonMark destination decoding (the C2 core hole) ----
  // The raw Lezer URL slice is the source bytes between delimiters, NOT
  // the CommonMark-decoded destination. Without
  // decodeMarkdownDestination(), each row's scheme is obscured and
  // isAllowedUrl misses it — fail-open. Each row MUST reject.

  it("decodes an angle-bracketed destination [t](<javascript:alert(1)>)", () => {
    expect(findUnsafeUrl("[t](<javascript:alert(1)>)\n")?.code).toBe("unsafe_url");
  });

  it("decodes a backslash-escaped colon [t](javascript\\:alert(1))", () => {
    // CommonMark §2.4: ASCII punctuation backslash-escapes are removed
    // during interpretation. Raw slice retains `\:` which obscures the
    // scheme; the decoder must unescape before isAllowedUrl runs.
    expect(findUnsafeUrl("[t](javascript\\:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a numeric character reference [t](javascript&#58;alert(1))", () => {
    // CommonMark §6.2: numeric (`&#58;`) and named character references
    // in URL destinations are decoded during interpretation. Raw slice
    // retains `&#58;` which obscures the scheme.
    expect(findUnsafeUrl("[t](javascript&#58;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a hex character reference [t](javascript&#x3A;alert(1))", () => {
    expect(findUnsafeUrl("[t](javascript&#x3A;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a numeric reference WITHOUT trailing `;` (numeric arm `;?` policy)", () => {
    // Numeric refs are `;`-optional: the digit-run terminates
    // unambiguously at the first non-digit, so `&#58alert` decodes
    // the `&#58` part (0x3A -> `:`) and the rest follows literally.
    // Reverting `;?` -> `;` (required) for symmetry with the named arm
    // would silently drop the fail-closed posture on adversarially
    // semicolon-stripped inputs — this row guards that policy.
    expect(findUnsafeUrl("[t](javascript&#58alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a hex numeric reference WITHOUT trailing `;` (numeric arm `;?` policy)", () => {
    // Hex companion to the decimal `;`-optional row above. The
    // following character `:` is not a hex digit, so the hex-digit
    // run terminates cleanly at `3A` and decodes to `:`, yielding
    // `javascript::...` (scheme `javascript`, rejected). NOTE: a
    // tail like `&#x3Aalert` would extend the greedy hex run into
    // `&#x3Aa` (= U+03AA) and break the scheme regex — fail-open.
    // We pin the policy with a sequence that exercises the `;`-
    // optional path WITHOUT accidentally relying on a hex-digit
    // continuation.
    expect(findUnsafeUrl("[t](javascript&#x3A:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a named character reference [t](javascript&colon;alert(1))", () => {
    expect(findUnsafeUrl("[t](javascript&colon;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("rejects a chained backslash + char-ref scheme [t](javascript\\&colon;alert(1))", () => {
    // Composed witness: BOTH decode passes must fire on the same input.
    // `\&colon;` carries a backslash-escape arm AND a character-reference
    // arm in the same scheme prefix. A refactor that drops or
    // short-circuits either pass leaves the scheme obscured:
    //   - drop backslash escapes: `\&colon;` survives, scheme regex stops
    //     at `\`, URL classified as relative path -> ACCEPT.
    //   - drop char-ref decoding: `\&colon;` -> `&colon;`, scheme regex
    //     stops at `&`, relative path -> ACCEPT.
    // Both passes alive -> `\&colon;` -> `&colon;` -> `:` ->
    // `javascript:...` -> rejected by the allowlist.
    expect(findUnsafeUrl("[t](javascript\\&colon;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a scheme-letter character reference [t](jav&#x61;script:alert(1))", () => {
    // `&#x61;` is `a`. Decodes to `javascript:` — the most adversarial
    // form because the scheme delimiter `:` is left alone but a scheme
    // letter is hidden.
    expect(findUnsafeUrl("[t](jav&#x61;script:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes an UPPERCASE-prefix hex reference [t](javascript&#X3A;alert(1))", () => {
    // The hex regex must accept both `#x` and `#X` (CommonMark
    // allows either prefix). If only lowercase `x` matches, this
    // row stays unrejected — fail-open.
    expect(findUnsafeUrl("[t](javascript&#X3A;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a `&plus;` named entity that hides a scheme character", () => {
    // `&plus;` → `+`. Without `plus` in
    // NAMED_ENTITIES, `foo&plus;bar&colon;x` stays as
    // `foo&plus;bar:x`; the scheme regex stops at `foo` (because `&`
    // is not in the scheme char set) and isAllowedUrl returns true
    // (relative path), fail-open. With `plus` decoded the URL becomes
    // `foo+bar:x`, scheme = `foo+bar`, not in allowlist, rejected.
    expect(findUnsafeUrl("[t](foo&plus;bar&colon;x)\n")?.code).toBe("unsafe_url");
  });

  it("decodes a LOWERCASE `&tab;` as fail-closed policy overshoot", () => {
    // CommonMark §6.2 makes named entities case-sensitive, and real
    // browsers leave non-canonical `&tab;` as literal text in href
    // attribute contexts (no whitespace-strip on the un-decoded
    // form). We decode it anyway as a deliberate overshoot — the
    // gate over-accepts lowercase forms regardless of upstream
    // normalization behavior, intentionally rejecting an input the
    // reference parser would render inert. Without the lowercase
    // fallback the URL stays as `java&tab;script:alert(1)`, no
    // scheme detected, accept.
    expect(findUnsafeUrl("[t](java&tab;script:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a LOWERCASE `&newline;` as fail-closed policy overshoot", () => {
    // Same overshoot framing as the `&tab;` row above: browsers do
    // NOT decode lowercase `&newline;` in href contexts, but the
    // gate decodes both canonical (`&NewLine;`) and non-canonical
    // (`&newline;`) forms uniformly, then rejects via the C0 check.
    expect(findUnsafeUrl("[t](java&newline;script:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes `&period;` so a custom-scheme URL is recognized", () => {
    // `&period;` -> `.` is in the RFC 3986 scheme character set.
    // Without decoding, `foo&period;bar&colon;x` stays as
    // `foo&period;bar:x`; the scheme regex stops at `foo` (because `&`
    // is not in the scheme set) and isAllowedUrl returns true
    // (relative path), fail-open. With `period` decoded the URL
    // becomes `foo.bar:x`, scheme = `foo.bar` (`.` IS in the scheme
    // character class), not in allowlist, rejected.
    expect(findUnsafeUrl("[t](foo&period;bar&colon;x)\n")?.code).toBe("unsafe_url");
  });

  it("does NOT throw on an out-of-range numeric reference &#x110000; and rejects via NUL substitution", () => {
    // String.fromCodePoint throws RangeError on cp > 0x10FFFF. The
    // decoder MUST guard the upper bound and substitute NUL
    // (U+0000) for undecodable references rather than falling back
    // to the literal `&#x110000;` text — leaving the literal
    // would let an attacker break the head-anchored scheme regex
    // (`^([a-z][a-z0-9+.-]*):`) inside a would-be scheme prefix and
    // bypass the gate as a "relative path." NUL substitution makes
    // isAllowedUrl's C0 regex reject any URL containing an
    // undecodable reference, uniformly.
    expect(() => findUnsafeUrl("[t](https://example.com/&#x110000;)\n")).not.toThrow();
    // The verdict for URLs containing literal `&#x110000;` is
    // `unsafe_url`, not `null`: the NUL substitution closes the
    // bypass class uniformly, at the cost of rejecting URLs that
    // happen to carry an undecodable numeric reference in their
    // path. Deliberate trade-off: fail-closed over CommonMark-
    // literal.
    expect(findUnsafeUrl("[t](https://example.com/&#x110000;)\n")?.code).toBe("unsafe_url");
  });

  it("rejects a surrogate-encoded scheme-letter bypass via NUL substitution", () => {
    // `&#xD800;` is a high-surrogate code point and not decodable
    // to a scalar value. Leaving the literal `&#xD800;` intact
    // would be fail-open: the head-anchored scheme regex
    // `^([a-z][a-z0-9+.-]*):` FAILS on `javascript&#xD800;:alert(1)`
    // (the `&` interrupts the char class AND the regex requires
    // `:` directly after, not after an arbitrary literal);
    // schemeMatch is null; isAllowedUrl returns true (relative
    // path); ACCEPT. NUL (U+0000) substitution closes the hole:
    // the URL becomes `javascript :alert(1)`; isAllowedUrl's
    // C0 regex rejects the NUL; REJECT.
    expect(findUnsafeUrl("[t](javascript&#xD800;:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("rejects an unknown named entity inside a would-be scheme", () => {
    // Same scheme-bypass class as the surrogate case — an undecoded
    // `&unknownentity;` literal breaks the head-anchored scheme regex
    // the same way. NUL substitution for unknown named entities
    // keeps the policy uniform. Trade-off: a URL with a literal
    // `&unknownentity;` would have been accepted under CommonMark-
    // literal interpretation; we deliberately reject it per the
    // "fail-closed over CommonMark-literal" principle.
    expect(findUnsafeUrl("[t](javascript&unknownentity;:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a control-character named entity [t](java&Tab;script:alert(1))", () => {
    // `&Tab;` → `\t` (0x09). After decoding, isAllowedUrl rejects via
    // its C0 control-char check.
    expect(findUnsafeUrl("[t](java&Tab;script:alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes an angle-bracketed definition destination", () => {
    expect(findUnsafeUrl("[t][id]\n\n[id]: <javascript:alert(1)>\n")?.code).toBe("unsafe_url");
  });

  it("decodes an inline IMAGE with a named entity ![a](javascript&colon;alert(1))", () => {
    expect(findUnsafeUrl("![a](javascript&colon;alert(1))\n")?.code).toBe("unsafe_url");
  });

  it("decodes a definition destination with a numeric entity", () => {
    expect(findUnsafeUrl("[t][id]\n\n[id]: javascript&#58;alert(1)\n")?.code).toBe("unsafe_url");
  });

  it("does NOT reach into raw-HTML attribute URLs (Option A)", () => {
    expect(findUnsafeUrl('Click <a href="javascript:alert(1)">here</a>.\n')).toBeNull();
  });

  it("returns null for an unresolved reference (no destination to gate)", () => {
    // A use-site `[t]` with no matching definition has no destination —
    // nothing renders as a link, so nothing to gate. The walker must
    // NOT crash and must NOT spuriously reject.
    expect(findUnsafeUrl("[t] with no definition\n")).toBeNull();
  });

  it("rejects protocol-relative // host destination", () => {
    expect(findUnsafeUrl("[t](//evil.example.com/x)\n")?.code).toBe("unsafe_url");
  });

  it("rejects embedded control characters", () => {
    expect(findUnsafeUrl("[t](java script:alert(1))\n")?.code).toBe("unsafe_url");
  });
});
