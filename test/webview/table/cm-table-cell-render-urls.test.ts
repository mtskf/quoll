// @vitest-environment happy-dom
// The destination gate: which URLs the table-cell renderer turns into a live
// `<a href>` / `<img src>` / autolink, and what it renders instead when it
// refuses. Four arms of one contract — the scheme allowlist (with the entity and
// backslash bypasses that made it necessary), CommonMark destination parsing,
// the MAX_HREF_LENGTH render cap, and relative-image directory containment.
// Refusal always takes the same shape, the construct's own source rendered inert
// as text, which is why so many expectations here are the input string back.
// The cap lives here rather than with the click routing because it decides
// whether an anchor is created at all: an over-cap URL never becomes a live
// `<a>`, so no native gesture (Open Link, middle-click, drag-to-address-bar) can
// reach a URL the host's open-external sink would reject. The two at-cap rows
// observe a click only as proof the anchor really did go live.
// What a link does once it IS live is cm-table-cell-render-clicks.test.ts; how
// the delimiters around it pair is cm-table-cell-render-emphasis.test.ts.
// Fixtures: helpers/cell-render-fixtures.ts.
import { describe, expect, it } from "vitest";

import { MAX_HREF_LENGTH } from "../../../src/shared/protocol.js";
import { renderCellInline } from "../../../src/webview/cm/table/cell-render.js";
import { html, htmlWithoutTooltip } from "./helpers/cell-render-fixtures.js";

describe("renderCellInline — the destination gate", () => {
  it("renders an inline link [text](url) as <a href> when URL is allowed", () => {
    const nodes = renderCellInline("see [docs](https://example.com)");
    // Strip `title="…"` before comparing — the discoverability tooltip
    // resolves "Cmd" vs "Ctrl" at module load via `navigator.platform`,
    // so pinning it inline makes the snapshot platform-dependent. The
    // dedicated tooltip test (clicks suite) uses an environment-safe regex; the
    // structural snapshot should be platform-agnostic.
    expect(htmlWithoutTooltip(nodes)).toBe(
      'see <a href="https://example.com" rel="noopener noreferrer">docs</a>'
    );
  });

  it("renders an unsafe inline link as inert text", () => {
    const nodes = renderCellInline("[bad](javascript:alert(1))");
    expect(html(nodes)).toBe("[bad](javascript:alert(1))");
  });

  // CommonMark §2.4: only ASCII punctuation is backslash-escapable. In
  // `[a](x\ y)` the `\ ` is a literal backslash, so the unescaped space
  // terminates the bare destination and this is NOT a link — matching the
  // Lezer write-gate parse. The escaped-punctuation case (`\)`) must still
  // suppress the paren so a genuine escape keeps the link live.
  it("renders `[a](x\\ y)` as literal text (`\\ ` is not an escape)", () => {
    expect(html(renderCellInline("[a](x\\ y)"))).toBe("[a](x\\ y)");
  });

  it("keeps `[a](x\\)y)` a live link (punctuation escape suppresses the paren)", () => {
    expect(htmlWithoutTooltip(renderCellInline("[a](x\\)y)"))).toBe(
      '<a href="x)y" rel="noopener noreferrer">a</a>'
    );
  });

  // CommonMark backslash + HTML-entity bypass. Without decoding the
  // destination before the allowlist gate, `javascript&#58;…`
  // and `javascript\:…` look schemeless to the regex in `isAllowedUrl`,
  // get classified as "relative", and ship as a live `<a href>` that the
  // browser then resolves to `javascript:…` → XSS.
  it("blocks `[bad](javascript&#58;alert(1))` (HTML-entity scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript&#58;alert(1))");
    expect(html(nodes)).toBe("[bad](javascript&amp;#58;alert(1))");
  });

  it("blocks `[bad](javascript\\:alert(1))` (backslash-escape scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript\\:alert(1))");
    expect(html(nodes)).toBe("[bad](javascript\\:alert(1))");
  });

  it("blocks `[bad](javascript&colon;alert(1))` (named-entity scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript&colon;alert(1))");
    expect(html(nodes)).toBe("[bad](javascript&amp;colon;alert(1))");
  });

  it("renders an inline image ![alt](url) as <img src> with alt", () => {
    const nodes = renderCellInline("![logo](https://x.test/a.png)");
    expect(html(nodes)).toBe('<img src="https://x.test/a.png" alt="logo">');
  });

  it("CommonMark-normalizes an image alt (![*em*](url) -> alt=em)", () => {
    const nodes = renderCellInline("![*em*](https://x.test/a.png)");
    expect(html(nodes)).toBe('<img src="https://x.test/a.png" alt="em">');
  });

  it("decodes an entity in an image alt (![a&amp;b](url) -> alt=a&b)", () => {
    const nodes = renderCellInline("![a&amp;b](https://x.test/a.png)");
    // innerHTML re-encodes & in the attribute, so assert via the DOM node.
    expect((nodes[0] as HTMLImageElement).alt).toBe("a&b");
  });

  it("renders an unsafe inline image as inert text", () => {
    const nodes = renderCellInline("![x](javascript:1)");
    expect(html(nodes)).toBe("![x](javascript:1)");
  });

  it("blocks `![x](javascript&#58;1)` image (HTML-entity scheme bypass)", () => {
    const nodes = renderCellInline("![x](javascript&#58;1)");
    expect(html(nodes)).toBe("![x](javascript&amp;#58;1)");
  });

  it("does not cap image src at MAX_HREF_LENGTH (images are exempt — no open-external round-trip)", () => {
    const longUrl = `https://x.test/${"a".repeat(9000)}.png`; // > MAX_HREF_LENGTH
    const nodes = renderCellInline(`![x](${longUrl})`);
    const [img] = nodes as HTMLImageElement[];
    expect(img).toBeInstanceOf(HTMLImageElement);
    expect(img.src).toBe(longUrl);
  });

  // ── Consolidated table-cell URL-gate semantics (shared decode→gate) ─────────
  // After routing through the shared renderSafeMarkdownDestination, these inputs
  // are gated identically to the block-image widget + the host write-gate. The
  // first four were LIVE <a>/<img> under the old local decoder (which left the
  // encoded form literal / required a trailing `;` / was case-sensitive); the
  // shared canonical decoder resolves or NUL-substitutes them → blocked.
  it("blocks `[bad](javascript&unknownentity;:1)` (unknown-entity bypass → NUL)", () => {
    expect(html(renderCellInline("[bad](javascript&unknownentity;:1)"))).toBe(
      "[bad](javascript&amp;unknownentity;:1)"
    );
  });

  it("blocks `[bad](javascript&#58alert(1))` (semicolonless numeric ref decodes to `:`)", () => {
    expect(html(renderCellInline("[bad](javascript&#58alert(1))"))).toBe(
      "[bad](javascript&amp;#58alert(1))"
    );
  });

  it("blocks `[bad](javascript&COLON;alert(1))` (uppercase named ref, case-insensitive)", () => {
    expect(html(renderCellInline("[bad](javascript&COLON;alert(1))"))).toBe(
      "[bad](javascript&amp;COLON;alert(1))"
    );
  });

  it("blocks `[bad](java&tab;script:1)` (control entity decodes to TAB → C0 reject)", () => {
    expect(html(renderCellInline("[bad](java&tab;script:1)"))).toBe("[bad](java&amp;tab;script:1)");
  });

  // Benign URLs still render live — the named-entity arm requires a trailing `;`,
  // so plain query params survive, and `&amp;` decodes to `&` and stays safe.
  it("keeps a plain multi-param query link live (`[x](https://x.test/?a=1&b=2)`)", () => {
    expect(htmlWithoutTooltip(renderCellInline("[x](https://x.test/?a=1&b=2)"))).toBe(
      '<a href="https://x.test/?a=1&amp;b=2" rel="noopener noreferrer">x</a>'
    );
  });

  it("keeps a `&amp;`-bearing query link live (`[x](https://x.test/?q=a&amp;b)`)", () => {
    expect(htmlWithoutTooltip(renderCellInline("[x](https://x.test/?q=a&amp;b)"))).toBe(
      '<a href="https://x.test/?q=a&amp;b" rel="noopener noreferrer">x</a>'
    );
  });

  // OVER-BLOCK POLICY (Codex Conf 95): a safe-scheme URL carrying a non-curated
  // semicolon-terminated named entity (`&copy;`) is undecodable → NUL → blocked.
  // This was a LIVE link under the old local decoder; the consolidation makes
  // table-cell render match the write-gate (non-persistable) + block-image gate.
  it("blocks `[x](https://x.test/?q=a&copy;b)` (non-curated entity over-block policy)", () => {
    expect(html(renderCellInline("[x](https://x.test/?q=a&copy;b)"))).toBe(
      "[x](https://x.test/?q=a&amp;copy;b)"
    );
  });

  it("renders an autolink <https://…> as <a href> when allowed", () => {
    const nodes = renderCellInline("see <https://example.com>");
    expect(htmlWithoutTooltip(nodes)).toBe(
      'see <a href="https://example.com" rel="noopener noreferrer">https://example.com</a>'
    );
  });

  it("leaves an unsafe autolink as inert text", () => {
    const nodes = renderCellInline("<javascript:alert(1)>");
    expect(html(nodes)).toBe("&lt;javascript:alert(1)&gt;");
  });

  // error-handler re-review Conf 82 — balanced parens in URLs (CommonMark §6.6).
  // Without depth-aware parsing, Wikipedia / MDN URLs containing `(...)` would
  // truncate at the first `)` and ship a broken href.
  it("preserves balanced parens in a URL (CommonMark §6.6)", () => {
    const nodes = renderCellInline(
      "[Rust](https://en.wikipedia.org/wiki/Rust_(programming_language))"
    );
    expect(htmlWithoutTooltip(nodes)).toBe(
      '<a href="https://en.wikipedia.org/wiki/Rust_(programming_language)" rel="noopener noreferrer">Rust</a>'
    );
  });

  it("preserves a backslash-escaped `)` inside the URL", () => {
    const nodes = renderCellInline("[x](https://e.test/a\\)b)");
    // The decoded URL is `https://e.test/a)b`. allowlist passes (https scheme).
    expect(htmlWithoutTooltip(nodes)).toBe(
      '<a href="https://e.test/a)b" rel="noopener noreferrer">x</a>'
    );
  });

  it("rejects an unescaped `<` or `>` inside the URL (CommonMark §6.3)", () => {
    // `[x](foo<bar)` is not a well-formed link — destination must not contain
    // bare `<` / `>`. Falls back to literal text.
    expect(html(renderCellInline("[x](foo<bar)"))).toBe("[x](foo&lt;bar)");
    expect(html(renderCellInline("[x](foo>bar)"))).toBe("[x](foo&gt;bar)");
  });

  // Over-cap containment (render-layer MAX_HREF_LENGTH gate). An allowlist-safe
  // but over-length URL is capped at RENDER time — it never becomes a live
  // `<a href>` — so NO native gesture (right-click "Open Link", middle-click,
  // drag-to-address-bar) can open a URL the host `open-external` sink would
  // reject. This is the sandbox-independent close for the context-menu bypass:
  // whatever the native menu can reach is byte-identical to what the host sink
  // would open, so `contextmenu` can stay un-suppressed (a11y). Rendered inert,
  // it merges into surrounding text like any non-allowlisted URL.
  it("renders an over-length allowlist-safe link inert (no live <a> — unreachable by native Open Link)", () => {
    const longUrl = `https://example.com/${"a".repeat(9000)}`; // > MAX_HREF_LENGTH (8192)
    const src = `[x](${longUrl})`;
    const nodes = renderCellInline(src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe(src); // inert source slice, no anchor
  });

  it("absolute href at exactly MAX_HREF_LENGTH renders live and modifier-click is NOT preventDefault'd (at-cap boundary)", () => {
    const prefix = "https://x.example.com/";
    const atCap = `${prefix}${"a".repeat(MAX_HREF_LENGTH - prefix.length)}`;
    expect(atCap.length).toBe(MAX_HREF_LENGTH); // guard against miscalc
    const [a] = renderCellInline(`[x](${atCap})`) as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement); // at cap → still a live link
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false); // within cap → routes via root handler
    }
  });

  it("absolute href one over MAX_HREF_LENGTH renders inert (just-over-cap boundary)", () => {
    const prefix = "https://x.example.com/";
    const overCap = `${prefix}${"a".repeat(MAX_HREF_LENGTH - prefix.length + 1)}`;
    expect(overCap.length).toBe(MAX_HREF_LENGTH + 1);
    const src = `[x](${overCap})`;
    const nodes = renderCellInline(src);
    // Render-layer cap: one byte over → no live <a>, inert source text.
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe(src);
  });

  it("renders an over-length allowlist-safe autolink inert (parity with inline links)", () => {
    const src = `<https://example.com/${"a".repeat(9000)}>`;
    const nodes = renderCellInline(src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    // Autolink inert path HTML-escapes the angle brackets (matches the unsafe
    // autolink case above); assert via textContent to stay escaping-agnostic.
    expect(nodes[0].textContent).toBe(src);
  });

  it("autolink href at exactly MAX_HREF_LENGTH renders live (at-cap boundary, autolink arm)", () => {
    const prefix = "https://x.example.com/";
    const atCap = `${prefix}${"a".repeat(MAX_HREF_LENGTH - prefix.length)}`;
    expect(atCap.length).toBe(MAX_HREF_LENGTH);
    const [a] = renderCellInline(`<${atCap}>`) as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
  });

  it("autolink href one over MAX_HREF_LENGTH renders inert (just-over-cap boundary, autolink arm)", () => {
    const prefix = "https://x.example.com/";
    const overCap = `${prefix}${"a".repeat(MAX_HREF_LENGTH - prefix.length + 1)}`;
    expect(overCap.length).toBe(MAX_HREF_LENGTH + 1);
    const src = `<${overCap}>`;
    const nodes = renderCellInline(src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
  });

  // ── Relative-image containment (resolveAgainstBase parity with the block-
  // image widget) ─────────────────────────────────────────────────────────────
  // A schemeless relative destination passes the scheme allowlist, but the
  // <img src> must NOT ship raw: it resolves against the document's resource
  // base and passes resolveTrustedResourceUrl's directory containment, exactly
  // like image/image-field.ts. Without a base (default ""), fail closed.
  describe("relative image containment", () => {
    const BASE = "https://csp/ws/notes/a.md";

    it("resolves a sibling ./img.png against the resource base", () => {
      const nodes = renderCellInline("![x](./img.png)", BASE);
      expect(html(nodes)).toBe('<img src="https://csp/ws/notes/img.png" alt="x">');
    });

    it("renders ../secret.png as inert text (directory escape)", () => {
      const nodes = renderCellInline("![x](../secret.png)", BASE);
      expect(html(nodes)).toBe("![x](../secret.png)");
    });

    it("renders ..%2fsecret.png as inert text (encoded dot-segment smuggle)", () => {
      const nodes = renderCellInline("![x](..%2fsecret.png)", BASE);
      expect(html(nodes)).toBe("![x](..%2fsecret.png)");
    });

    it("renders a relative image as inert text when no base is provided", () => {
      const nodes = renderCellInline("![x](./img.png)");
      expect(html(nodes)).toBe("![x](./img.png)");
    });

    it("passes an absolute https image through unchanged (base present)", () => {
      const nodes = renderCellInline("![x](https://x.test/a.png)", BASE);
      expect(html(nodes)).toBe('<img src="https://x.test/a.png" alt="x">');
    });

    it("renders a fragment-only image destination as inert text", () => {
      const nodes = renderCellInline("![x](#frag)", BASE);
      expect(html(nodes)).toBe("![x](#frag)");
    });

    it("threads the base through emphasis recursion (*![x](./img.png)*)", () => {
      const nodes = renderCellInline("*![x](./img.png)*", BASE);
      expect(html(nodes)).toBe('<em><img src="https://csp/ws/notes/img.png" alt="x"></em>');
    });
  });
});
