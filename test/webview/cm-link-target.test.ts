import { describe, expect, it } from "vitest";

import { decodeMarkdownDestination } from "../../src/markdown/url-decode.js";
import { MAX_HREF_LENGTH } from "../../src/shared/protocol.js";
import { classifyLinkTarget, isActionableLinkTarget } from "../../src/webview/cm/link-target.js";

describe("classifyLinkTarget", () => {
  it("classifies http / https / mailto as external", () => {
    expect(classifyLinkTarget("https://example.com")).toEqual({
      kind: "external",
      href: "https://example.com",
    });
    expect(classifyLinkTarget("http://x")).toEqual({ kind: "external", href: "http://x" });
    expect(classifyLinkTarget("mailto:a@b.c")).toEqual({
      kind: "external",
      href: "mailto:a@b.c",
    });
  });

  it("classifies a relative .md destination as workspace, fragment included", () => {
    expect(classifyLinkTarget("notes.md")).toEqual({ kind: "workspace", href: "notes.md" });
    expect(classifyLinkTarget("./sub/notes.MD#heading")).toEqual({
      kind: "workspace",
      href: "./sub/notes.MD#heading",
    });
  });

  // The structural rules must be applied to the PERCENT-DECODED path, because
  // that is the form the host judges (handle-open-link.ts). Judging the raw
  // string instead made these classify as `workspace` — pointer cursor, post,
  // preventDefault — and the host then dropped them, eating the caret move too.
  it("applies the absolute / backslash / scheme rules to the percent-decoded path", () => {
    expect(classifyLinkTarget("%2Fetc.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("%5Cfoo.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("%2F%2Fhost.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("http%3A%2F%2Fexample.com%2Fx.md")).toEqual({ kind: "no-action" });
  });

  it("percent-decodes a legitimate escaped path, and falls back on a malformed one", () => {
    // `my%20notes.md` must still route — the decode exists to make the ordinary
    // escaped form work, not merely to reject things.
    expect(classifyLinkTarget("my%20notes.md")).toEqual({
      kind: "workspace",
      href: "my%20notes.md",
    });
    // A malformed escape throws inside decodeURIComponent; the host falls back
    // to the raw form so the link still resolves to its literal-named file, and
    // this side must agree. This catch is also what keeps the module total —
    // decodeURIComponent is the one throwing primitive here.
    expect(classifyLinkTarget("50%off.md")).toEqual({ kind: "workspace", href: "50%off.md" });
  });

  it("classifies the schemeless fall-through as no-action", () => {
    // The class this PR exists for: ordinary Markdown Quoll does not route.
    expect(classifyLinkTarget("#section")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("./photo.png")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("/abs.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("sub\\notes.md")).toEqual({ kind: "no-action" });
  });

  it("classifies an oversize destination before any allowlist work", () => {
    const long = `https://example.com/${"a".repeat(MAX_HREF_LENGTH)}`;
    expect(classifyLinkTarget(long)).toEqual({ kind: "oversize", length: long.length });
  });

  it("classifies a non-allowlisted destination, naming only known schemes", () => {
    expect(classifyLinkTarget("javascript:alert(1)")).toEqual({
      kind: "blocked",
      schemeToken: "javascript",
    });
    // Protocol-relative: isAllowedUrl rejects it and schemeOf finds no scheme.
    expect(classifyLinkTarget("//evil.example.com/x")).toEqual({
      kind: "blocked",
      schemeToken: "(none)",
    });
  });

  it("never emits href bytes through schemeToken (NO-URL POLICY boundary)", () => {
    // The whole reason the token is classified INSIDE this module: a private
    // pseudo-scheme must not survive into anything a consumer could log.
    const target = classifyLinkTarget("MyVault-Passw0rd.notes:entry");
    expect(target).toEqual({ kind: "blocked", schemeToken: "(unrecognised)" });
    expect(JSON.stringify(target)).not.toContain("Passw0rd");
  });

  it("is actionable for exactly external + workspace", () => {
    expect(isActionableLinkTarget({ kind: "external", href: "https://x" })).toBe(true);
    expect(isActionableLinkTarget({ kind: "workspace", href: "a.md" })).toBe(true);
    expect(isActionableLinkTarget({ kind: "no-action" })).toBe(false);
    expect(isActionableLinkTarget({ kind: "oversize", length: 1 })).toBe(false);
    expect(isActionableLinkTarget({ kind: "blocked", schemeToken: "(none)" })).toBe(false);
    expect(isActionableLinkTarget({ kind: "unopenable-scheme", scheme: "ftp" })).toBe(false);
  });
});

// Totality is a hard contract, not a nicety: this function runs inside
// DecorationProvider.build(), the orchestrator drives every INLINE decoration
// provider from a single shared ViewPlugin, and CodeMirror permanently
// deactivates a plugin that throws (@codemirror/view PluginInstance.update →
// logException → deactivate). A throw here would silently strip the whole
// inline reveal layer — emphasis, inline code, links — until a reload. (Block
// widgets are StateFields and some constructs own their ViewPlugin, so those
// survive; the blast radius is the shared plugin, not the editor entire.) The
// contract is pinned rather than trusted. Deliberately NOT solved with a
// try/catch at the call site: that would convert a future real bug into a
// silently-missing cursor. Fail loudly in CI instead of quietly in production.
describe("classifyLinkTarget — totality (never throws)", () => {
  const HOSTILE = [
    "",
    " ",
    "#",
    ":",
    "//",
    "\\",
    "\u0000",
    "\u007f",
    "https://example.com/\u0000",
    "50%off.md",
    "%",
    "%zz",
    "%e0%a4%a",
    "\ud800", // lone high surrogate
    "\udfff", // lone low surrogate
    "&#xFFFFFFFF;",
    "&#999999999999;",
    "&#x110000;", // just past the Unicode max code point
    "a".repeat(100_000),
    "\\\\?\\C:\\Windows\\System32",
    "javascript:/*\u0000*/alert(1)",
  ];

  it("returns a LinkTarget for every hostile destination, raw and decoded", () => {
    for (const raw of HOSTILE) {
      // Pin the exact composition the decoration path runs: decode, then
      // classify. A throw in EITHER half has the same fatal blast radius.
      expect(() => classifyLinkTarget(raw)).not.toThrow();
      expect(() => classifyLinkTarget(decodeMarkdownDestination(raw))).not.toThrow();
      expect(typeof classifyLinkTarget(decodeMarkdownDestination(raw)).kind).toBe("string");
    }
  });
});
