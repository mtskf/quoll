import { describe, expect, it } from "vitest";

import { decodeMarkdownDestination } from "../../src/markdown/url-decode.js";
import { MAX_HREF_LENGTH } from "../../src/shared/protocol.js";
import { classifyLinkTarget } from "../../src/webview/cm/link-target.js";
import {
  OPEN_LINK_CONTAINMENT_ONLY_REJECTIONS,
  OPEN_LINK_STRUCTURAL_MATRIX,
} from "../fixtures/open-link-destinations.js";

// The cross-boundary half of this suite. Every row below is asserted by the
// host suite too (test/extension/links/handle-open-link.test.ts) off the SAME
// fixture, so the webview's `relativeMarkdownTarget` copy of the cascade cannot
// drift from `handleOpenLink`'s without reddening both files. Read the fixture
// header for what the matrix does and does not claim.
describe("classifyLinkTarget — shared open-link structural matrix", () => {
  for (const { destination, hostRoutes, why } of OPEN_LINK_STRUCTURAL_MATRIX) {
    it(`${hostRoutes ? "routes" : "does not route"} — ${why}`, () => {
      // The biconditional, not the arm: `workspace` is exactly the class the
      // webview posts as `open-link`, so anything else (external, blocked,
      // no-action) is a non-route no matter which. Arm-exactness is pinned
      // separately below, where it is webview-only information.
      expect(classifyLinkTarget(destination).kind === "workspace").toBe(hostRoutes);
    });
  }
});

// The one place the two sides legitimately disagree. Pinned so it stays a
// documented split of responsibility rather than looking like the drift the
// matrix above exists to catch: the webview owns no path, so it classifies
// these as `workspace` and posts them; only the host can resolve them and see
// that they escape.
describe("classifyLinkTarget — containment is the host's call, not the webview's", () => {
  for (const { destination, why } of OPEN_LINK_CONTAINMENT_ONLY_REJECTIONS) {
    it(`classifies as workspace even though the host will drop it — ${why}`, () => {
      expect(classifyLinkTarget(destination).kind).toBe("workspace");
    });
  }
});

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

  // WHETHER these route is the shared matrix's job; this pins WHAT gets posted.
  // The href must be the destination VERBATIM — the host re-derives everything
  // from the raw string (fragment split, single percent-decode, join), so any
  // normalisation here would mean the two sides resolve different files.
  it("carries the destination verbatim on the workspace arm", () => {
    expect(classifyLinkTarget("notes.md")).toEqual({ kind: "workspace", href: "notes.md" });
    // Fragment and percent-escapes survive untouched — decoding is the host's.
    expect(classifyLinkTarget("./sub/notes.MD#heading")).toEqual({
      kind: "workspace",
      href: "./sub/notes.MD#heading",
    });
    expect(classifyLinkTarget("my%20notes.md")).toEqual({
      kind: "workspace",
      href: "my%20notes.md",
    });
    // A malformed escape throws inside decodeURIComponent and falls back to the
    // raw form on both sides. That catch is also what keeps the module total —
    // decodeURIComponent is the one throwing primitive here.
    expect(classifyLinkTarget("50%off.md")).toEqual({ kind: "workspace", href: "50%off.md" });
  });

  it("classifies the schemeless fall-through as no-action", () => {
    // Arm-exactness for the non-routing classes — webview-only information the
    // shared matrix cannot carry (it only knows "the host does not route it",
    // which `external` also satisfies while STILL being actionable).
    // `no-action` is the SILENT class by design: link-handlers keeps one warn
    // per gate-reject arm (oversize / blocked / unopenable-scheme — PR #332's
    // triage trail) and deliberately none here, and link-reveal withholds the
    // pointer cursor for exactly this arm. A leading `#` is no longer part of
    // this class — it is the `fragment` arm now, pinned separately in
    // "classifyLinkTarget — fragments" below.
    expect(classifyLinkTarget("./photo.png")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("/abs.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("sub\\notes.md")).toEqual({ kind: "no-action" });
    // The decoded-form class (PR #340): rejected on the percent-DECODED path,
    // so each lands on the same silent arm rather than looking like a blocked
    // URL. "Not workspace" is NOT enough for these, which is why the shared
    // matrix row cannot replace them: if the decode ever moved ahead of the
    // scheme gate, `http%3A…` would classify as `external` — pointer cursor,
    // open-external post, browser launch — while every matrix row stayed green.
    expect(classifyLinkTarget("%2Fetc.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("%5Cfoo.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("%2F%2Fhost.md")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("http%3A%2F%2Fexample.com%2Fx.md")).toEqual({ kind: "no-action" });
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
});

describe("classifyLinkTarget — fragments", () => {
  it("classifies a bare fragment as the fragment arm, slugified", () => {
    expect(classifyLinkTarget("#sec")).toEqual({ kind: "fragment", slug: "sec" });
    expect(classifyLinkTarget("#Getting-Started")).toEqual({
      kind: "fragment",
      slug: "getting-started",
    });
  });

  it("percent-decodes the fragment before slugging", () => {
    expect(classifyLinkTarget("#My%20Section")).toEqual({ kind: "fragment", slug: "my-section" });
  });

  it("falls back to the raw fragment on a malformed escape instead of throwing", () => {
    expect(classifyLinkTarget("#50%off")).toEqual({ kind: "fragment", slug: "50off" });
  });

  it("treats an empty or unsluggable fragment as no-action", () => {
    expect(classifyLinkTarget("#")).toEqual({ kind: "no-action" });
    expect(classifyLinkTarget("#!!!")).toEqual({ kind: "no-action" });
  });

  it("leaves a `.md#sec` destination on the workspace arm — the host owns it", () => {
    expect(classifyLinkTarget("notes.md#sec")).toEqual({ kind: "workspace", href: "notes.md#sec" });
  });

  it("keeps the oversize cap ahead of the fragment arm", () => {
    const huge = `#${"a".repeat(MAX_HREF_LENGTH)}`;
    expect(classifyLinkTarget(huge).kind).toBe("oversize");
  });

  it("keeps the allowlist ahead of the fragment arm", () => {
    // A C0 byte is an allowlist reject, not a fragment. (A space is NOT —
    // isAllowedUrl permits it, so `#a b` is a fragment that slugs to `a-b`.)
    // Write the byte as an ESCAPE, matching the HOSTILE matrix below: a raw
    // control character renders as `#sec` on screen and in the diff, which
    // reads as a verbatim contradiction of the fragment assertion above and
    // goes green-and-vacuous the moment any tool normalises it away.
    expect(classifyLinkTarget("#se\u0001c")).toEqual({ kind: "blocked", schemeToken: "(none)" });
  });

  it("stays document-free: the arm carries a slug and no resolution", () => {
    // link-target.ts must not learn about headings. If this ever needs an
    // EditorState to answer, the module boundary has been broken.
    expect(classifyLinkTarget("#anything-at-all")).toEqual({
      kind: "fragment",
      slug: "anything-at-all",
    });
  });
});

// Totality is a hard contract, not a nicety: this function runs inside
// DecorationProvider.build(), which the orchestrator drives for every INLINE
// decoration provider from a single shared ViewPlugin. The orchestrator now
// CONTAINS a throw there — the failing provider drops its own decorations for
// that build and the others stay live — so a violation costs one missing link
// affordance and a deduped console.error nobody reads, NOT an obviously dead
// editor. That makes this matrix more important, not less: containment removed
// the loud symptom, so these direct calls are the only thing left that turns a
// totality regression red. Deliberately NOT solved with a try/catch at the call
// site either: that would swallow the bug where no test is looking.
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
      // classify. A throw in EITHER half is contained the same way — and so
      // goes unnoticed the same way without this pin.
      expect(() => classifyLinkTarget(raw)).not.toThrow();
      expect(() => classifyLinkTarget(decodeMarkdownDestination(raw))).not.toThrow();
      expect(typeof classifyLinkTarget(decodeMarkdownDestination(raw)).kind).toBe("string");
    }
  });
});
