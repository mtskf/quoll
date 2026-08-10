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
// DecorationProvider.build(), the orchestrator registers ONE ViewPlugin for all
// providers, and CodeMirror permanently deactivates a plugin that throws
// (@codemirror/view PluginInstance.update → logException → deactivate). A throw
// here would silently strip EVERY decoration in the editor until a reload, so
// the contract is pinned rather than trusted. Deliberately NOT solved with a
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
