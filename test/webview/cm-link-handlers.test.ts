// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../src/shared/protocol.js";
import {
  handleLinkMouseDown,
  type LinkOpenHost,
  quollLinkClickHandler,
  tryOpenLinkAt,
} from "../../src/webview/cm/link-handlers.js";

// ---- tryOpenLinkAt (Task 7) ----

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function posOf(doc: string, marker: string): number {
  const i = doc.indexOf(marker);
  if (i < 0) {
    throw new Error(`marker not in doc: ${marker}`);
  }
  return i;
}

describe("tryOpenLinkAt — safe URLs", () => {
  it("posts open-external for an https Link on hover position", () => {
    const doc = "see [link](https://example.com) end";
    const state = stateOf(doc);
    const posted: Array<{ type: string; href?: string }> = [];
    const host = { postMessage: (m: { type: string; href?: string }) => posted.push(m) };
    // Position on the inline content `link` (between `[` and `]`).
    const pos = posOf(doc, "link") + 1;
    const handled = tryOpenLinkAt(state, pos, host);
    expect(handled).toBe(true);
    expect(posted).toEqual([{ protocol: 1, type: "open-external", href: "https://example.com" }]);
  });

  // Test-fixture convention: EditorState.create's default selection is
  // `{anchor: 0, head: 0}`. tryOpenLinkAt's revealed-link guard returns
  // false when the selection intersects the Link node — boundary-inclusive,
  // so caret-at-pos-0 INTERSECTS a Link node starting at pos 0. Every
  // safe-URL test below prefixes the doc with `"see "` (4 chars) so the
  // Link starts at pos ≥ 4 and the default caret-at-0 stays OUTSIDE.
  // Without the prefix, all "should post" assertions would fail
  // vacuously (return false from the revealed-link guard, never reaching
  // the URL gate).
  it("posts open-external for an http Link", () => {
    const doc = "see [t](http://x)";
    const state = stateOf(doc);
    const posted: Array<{ type: string; href?: string }> = [];
    const host = { postMessage: (m: { type: string; href?: string }) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(true);
    expect(posted[0]?.href).toBe("http://x");
  });

  it("posts open-external for a mailto Link", () => {
    const doc = "see [contact](mailto:a@b.c)";
    const state = stateOf(doc);
    const posted: Array<{ type: string; href?: string }> = [];
    const host = { postMessage: (m: { type: string; href?: string }) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "contact"), host)).toBe(true);
    expect(posted[0]?.href).toBe("mailto:a@b.c");
  });

  it("decodes the URL before posting (backslash-escaped colon)", () => {
    // CommonMark allows backslash-escaping the URL's bytes; the raw slice
    // is `https\:example.com`, decoded `https:example.com`. We post the
    // decoded form so the host's isAllowedUrl + Uri.parse see clean bytes.
    const doc = "see [t](https\\://example.com)";
    const state = stateOf(doc);
    const posted: Array<{ type: string; href?: string }> = [];
    const host = { postMessage: (m: { type: string; href?: string }) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(true);
    expect(posted[0]?.href).toBe("https://example.com");
  });
});

// ---- open-link (relative .md) branch ----
//
// Mirrors the "safe URLs" fixture convention: the doc is prefixed with
// `"see "` so the Link node starts at pos ≥ 4 and the default caret-at-0
// selection stays OUTSIDE it (otherwise the revealed-link guard returns
// false vacuously). `linkPos` lands on the inline link text so the click
// resolves to the Link node. `host.posted` collects the messages.
function setupLink(markup: string): {
  host: LinkOpenHost & { posted: WebviewToHost[] };
  state: EditorState;
  linkPos: number;
} {
  const doc = `see ${markup}`;
  const state = stateOf(doc);
  const posted: WebviewToHost[] = [];
  const host = { posted, postMessage: (m: WebviewToHost) => posted.push(m) };
  // Position on the first inline text char of the link label (`[X` → `X`).
  const linkPos = posOf(doc, markup) + 1;
  return { host, state, linkPos };
}

describe("tryOpenLinkAt — open-link (relative .md)", () => {
  it("posts open-link for a relative .md link", () => {
    const { host, state, linkPos } = setupLink("[go](./other.md)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(true);
    expect(host.posted).toContainEqual({
      protocol: PROTOCOL_VERSION,
      type: "open-link",
      href: "./other.md",
    });
  });

  it("posts open-link for a parent-relative .md link", () => {
    const { host, state, linkPos } = setupLink("[go](../notes/other.md)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(true);
    expect(host.posted).toContainEqual({
      protocol: PROTOCOL_VERSION,
      type: "open-link",
      href: "../notes/other.md",
    });
  });

  it("posts open-link (fragment retained) for a .md link with a #fragment", () => {
    const { host, state, linkPos } = setupLink("[go](./other.md#sec)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(true);
    expect(host.posted).toContainEqual({
      protocol: PROTOCOL_VERSION,
      type: "open-link",
      href: "./other.md#sec",
    });
  });

  it("still posts open-external for an https link", () => {
    const { host, state, linkPos } = setupLink("[go](https://example.com)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(true);
    expect(host.posted).toContainEqual({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "https://example.com",
    });
  });

  it("does not post for a relative non-.md link", () => {
    const { host, state, linkPos } = setupLink("[img](./photo.png)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(false);
    expect(host.posted).toEqual([]);
  });

  it("does not post for an absolute .md link (falls to caret move)", () => {
    const { host, state, linkPos } = setupLink("[x](/etc/passwd.md)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(false);
    expect(host.posted).toEqual([]);
  });

  // NOTE: backslash rejection is asserted deterministically in the HOST matrix
  // (Task 2 "rejects a backslash path") — handleOpenLink takes a raw string with
  // no markdown parse. A webview-side backslash test would have to thread a `\`
  // through the Lezer markdown parser + decodeMarkdownDestination (CommonMark
  // backslash-escape semantics), which is fragile; the webview `includes("\\")`
  // guard is defense-in-depth and its behaviour is pinned host-side.

  it("does not post for a fragment-only link", () => {
    const { host, state, linkPos } = setupLink("[x](#sec)");
    expect(tryOpenLinkAt(state, linkPos, host)).toBe(false);
    expect(host.posted).toEqual([]);
  });
});

describe("tryOpenLinkAt — unsafe URLs (render-gate INERT)", () => {
  const hostile: Array<[string, string]> = [
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript scheme with backslash colon", "javascript\\:alert(1)"],
    // The earlier draft used `"java\\nscript:alert(1)"` (literal backslash
    // + n) which does NOT exercise the C0 bypass —
    // decodeMarkdownDestination's backslash
    // escape only triggers on ASCII punctuation (CommonMark §2.4) and `n`
    // is not in that set, so the slice stayed as `java\nscript:alert(1)`
    // (literal backslash + n) and isAllowedUrl's scheme regex fell
    // through to "relative path, accept", letting the test pass for the
    // WRONG reason. The numeric entity `&#10;` decodes to a literal LF
    // (0x0A) that isAllowedUrl's C0 regex actually catches.
    ["javascript with C0 bypass (numeric entity)", "java&#10;script:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative", "//evil.example/x"],
    // Task 2's host matrix and Task 9's integration matrix BOTH carry
    // the backslash variant; keep this unit matrix symmetric so the
    // DRIFT WARNING invariant (both matrices cover the same hostile-URL
    // attack-scenario set) stays in sync. (The two C0-bypass rows —
    // inline `java&#10;script:...` and trailing `...example.com&#10;` —
    // deliberately differ by protocol design: webview ships the raw
    // entity form `&#10;`, host receives the post-decode literal `\n` —
    // so the matrices are not byte-identical, just attack-equivalent.)
    ["protocol-relative backslash", "\\\\evil.example/x"],
    ["vbscript scheme", "vbscript:msgbox"],
    ["javascript via numeric entity", "javascript&#58;alert(1)"],
    ["javascript via hex entity", "javascript&#x3A;alert(1)"],
    ["javascript via named entity", "javascript&colon;alert(1)"],
    ["javascript via surrogate substitute (NUL after decode)", "javascript&#xD800;:alert(1)"],
    // Trailing-C0 bypass (review-cycle 1 C1): `&#10;` decodes to a
    // literal LF. With the pre-fix trim-before-check order, trim()
    // would strip the trailing LF and the URL would pass. The fix moves
    // the C0 check ahead of trim(), so the trailing LF is rejected.
    ["trailing C0 via entity (&#10;)", "https://example.com&#10;"],
  ];

  // Same `"see "` prefix convention as the safe-URL block above — without
  // it the revealed-link guard short-circuits before any URL-gate code
  // runs, leaving the unsafe-URL matrix vacuously green. Prefixing keeps
  // the caret at pos 0 (default) OUTSIDE every Link's range and forces
  // the URL gate to run, so a regression in isAllowedUrl / scheme /
  // decode would flip these tests red.
  for (const [label, url] of hostile) {
    it(`does NOT post open-external for ${label}`, () => {
      const doc = `see [t](${url})`;
      const state = stateOf(doc);
      const posted: unknown[] = [];
      const host = { postMessage: (m: unknown) => posted.push(m) };
      const handled = tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host);
      // Two acceptable outcomes:
      //   (a) handled=false (caller falls through; caret moves into link
      //       and the user can edit/delete the unsafe URL)
      //   (b) handled=true with NO postMessage (silent swallow)
      // Either keeps the URL INERT. We assert the security invariant
      // (zero postMessage), and accept whichever handled flag the impl
      // returns. The chosen impl (Task 7) returns false to keep UX
      // consistent (click on unsafe → caret move → reveal).
      expect(posted).toEqual([]);
      expect(handled).toBe(false);
    });
  }
});

describe("tryOpenLinkAt — non-launchable safe URLs", () => {
  it("does NOT post for a relative path", () => {
    const doc = "see [t](/relative)";
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("does NOT post for a fragment-only URL", () => {
    const doc = "see [t](#frag)";
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(false);
    expect(posted).toEqual([]);
  });
});

describe("tryOpenLinkAt — non-Link positions", () => {
  it("returns false when the position is in plain paragraph text", () => {
    const doc = "just a paragraph";
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, 3, host)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("returns false when the Link is reference-form (no URL child)", () => {
    // Prefix preserved so the test pins "reference-form has no URL child
    // → return false" specifically, NOT "revealed guard fires first".
    const doc = "see [ref][def]\n\n[def]: https://example.com";
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[ref]") + 1, host)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("returns false for an Image (![alt](url)) — C7 owns image clicks", () => {
    const doc = "see ![alt](https://example.com)";
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "alt"), host)).toBe(false);
    expect(posted).toEqual([]);
  });
});

describe("tryOpenLinkAt — already revealed link (caret in link)", () => {
  // If the user has caret INSIDE the link (the linkReveal provider is
  // showing it REVEALED), the click should be
  // a caret repositioning — not an external open. tryOpenLinkAt returns
  // false so the caller falls through to default CM behaviour.
  it("returns false when state.selection intersects the Link node", () => {
    const doc = "[link](https://example.com)";
    const state = EditorState.create({
      doc,
      // Caret inside the inline content `link`.
      selection: EditorSelection.single(3),
      extensions: [markdown({ base: markdownLanguage })],
    });
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    // Click at position 3 (same as selection) — but the contract is "if
    // CURRENT selection intersects, do not open", so even a click that
    // would otherwise open returns false.
    expect(tryOpenLinkAt(state, 3, host)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("returns false when any cursor in a multi-cursor selection intersects the Link", () => {
    const doc = "[link](https://example.com) and other text";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(3), // inside the link
        EditorSelection.cursor(35), // far away
      ]),
      extensions: [markdown({ base: markdownLanguage })],
    });
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, 3, host)).toBe(false);
    expect(posted).toEqual([]);
  });
});

describe("tryOpenLinkAt — MAX_HREF_LENGTH guard", () => {
  it("returns false (and does not post) for href exceeding MAX_HREF_LENGTH", async () => {
    // Build a doc with an https URL longer than MAX_HREF_LENGTH. We use
    // path padding so the scheme stays valid. MAX_HREF_LENGTH = 8KB
    // (8192 chars); pick a path 9000 chars long so the total URL
    // comfortably exceeds the cap. `"see "` prefix keeps the
    // default-caret-at-0 outside the Link's revealed-guard boundary.
    const { MAX_HREF_LENGTH } = await import("../../src/shared/protocol.js");
    const padding = "a".repeat(MAX_HREF_LENGTH);
    const doc = `see [t](https://x/${padding})`;
    const state = stateOf(doc);
    const posted: unknown[] = [];
    const host = { postMessage: (m: unknown) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("accepts href at exactly MAX_HREF_LENGTH", async () => {
    const { MAX_HREF_LENGTH } = await import("../../src/shared/protocol.js");
    // Build a URL whose total decoded length equals MAX_HREF_LENGTH.
    // Construct it from a fixed prefix + path padding.
    const prefix = "https://x/";
    const padding = "a".repeat(MAX_HREF_LENGTH - prefix.length);
    const href = `${prefix}${padding}`;
    expect(href.length).toBe(MAX_HREF_LENGTH);
    const doc = `see [t](${href})`;
    const state = stateOf(doc);
    const posted: Array<{ type: string; href?: string }> = [];
    const host = { postMessage: (m: { type: string; href?: string }) => posted.push(m) };
    expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(true);
    expect(posted[0]?.href).toBe(href);
  });
});

// Review-cycle 1 (C2): `host.postMessage` is the only sync-throw site in
// tryOpenLinkAt and was previously unguarded. Asymmetric with
// `postEditMessage` in src/webview/editor.ts which wraps the same call in
// try/catch + `[quoll]` log. A throw on a disposed panel / structured-
// clone edge case would escape through `handleLinkMouseDown` → CM's
// mousedown handler with no log and no preventDefault, leaving the click
// silently broken.
describe("tryOpenLinkAt — host.postMessage failure (review-cycle 1 C2)", () => {
  it("returns false and logs [quoll] when postMessage throws", () => {
    const doc = "see [t](https://example.com)";
    const state = stateOf(doc);
    const host: LinkOpenHost = {
      postMessage: () => {
        throw new Error("simulated transport detach");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(tryOpenLinkAt(state, posOf(doc, "[t]") + 1, host)).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        "[quoll] postMessage(link-open) failed",
        expect.any(Error)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---- handleLinkMouseDown + quollLinkClickHandler (Task 8) ----

/** Mock EditorView shaped for handleLinkMouseDown. The helper only reads
 *  `view.state` (for tryOpenLinkAt) and `view.posAtCoords` (for the
 *  coord → pos resolution). Cast-as-EditorView is safe because the
 *  helper's surface is narrow. */
function makeMockView(
  state: EditorState,
  posAtCoords: (coords: { x: number; y: number }) => number | null
): EditorView {
  return {
    state,
    posAtCoords,
  } as unknown as EditorView;
}

/** Mock MouseEvent with the fields handleLinkMouseDown reads. */
function makeMockEvent(
  button: number,
  clientX = 100,
  clientY = 50
): MouseEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  return {
    button,
    clientX,
    clientY,
    preventDefault,
  } as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("handleLinkMouseDown — short-circuit branches", () => {
  it("returns false for non-left-button (button !== 0); does NOT preventDefault", () => {
    const state = EditorState.create({
      doc: "[t](https://x)",
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 1); // middle click
    const view = makeMockView(state, () => 1);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("returns false for right-click (button = 2); does NOT preventDefault", () => {
    const state = EditorState.create({
      doc: "[t](https://x)",
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 2);
    const view = makeMockView(state, () => 1);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("returns false when posAtCoords returns null (click outside text)", () => {
    const state = EditorState.create({
      doc: "[t](https://x)",
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 0);
    const view = makeMockView(state, () => null);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("returns false when posAtCoords returns a position outside doc range", () => {
    const state = EditorState.create({
      doc: "[t](https://x)",
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 0);
    // posAtCoords returns negative — out of range.
    const view = makeMockView(state, () => -1);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  // Review-cycle 1 (C4): the doc-range guard uses strict `pos > doc.length`,
  // so `pos === doc.length` is the boundary-inclusive upper edge that
  // proceeds to tryOpenLinkAt. The lower-bound `-1` case is covered above;
  // without this row the upper edge is unpinned and a future tightening
  // to `pos >= doc.length` would silently break clicks at end-of-doc.
  //
  // What we observe to pin `>` vs `>=`: handleLinkMouseDown reads
  // `view.state` once for the doc-length guard, then AGAIN for the
  // tryOpenLinkAt(view.state, ...) call. A `>=` regression would
  // short-circuit between those reads (returning false before the
  // second access). We count `view.state` accesses with a getter spy —
  // with the current `>` guard, `view.state` is read twice; with the
  // tightened `>=` guard, it is read once. Lezer's resolveInner at
  // pos === doc.length returns Document (not Link), so the URL contract
  // is intentionally NOT asserted here — the pin is purely on the
  // doc-range guard's "let it through" semantics, not on the open path.
  it("does NOT short-circuit when pos === view.state.doc.length (boundary-inclusive upper edge)", () => {
    const realState = EditorState.create({
      doc: "see [t](https://x)",
      extensions: [markdown({ base: markdownLanguage })],
    });
    let stateAccessCount = 0;
    const view = {
      get state() {
        stateAccessCount++;
        return realState;
      },
      posAtCoords: () => realState.doc.length,
    } as unknown as EditorView;
    const event = makeMockEvent(/* button */ 0);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    // No Link resolves at pos === doc.length (Lezer right-exclusive),
    // so handleLinkMouseDown ends up returning false either way.
    handleLinkMouseDown(event, view, host);
    // `view.state` MUST be read at least twice: once for the doc-length
    // guard, and once for the tryOpenLinkAt(view.state, ...) call past
    // the guard. A `>=` regression makes the second read disappear.
    expect(stateAccessCount).toBeGreaterThanOrEqual(2);
  });
});

describe("handleLinkMouseDown — success / failure paths", () => {
  // Same `"see "` prefix convention as Task 7: default
  // EditorState selection is anchor=0; without the prefix, a Link node
  // starting at pos 0 would trigger tryOpenLinkAt's revealed-guard and
  // mask both the success and unsafe-URL paths.
  it("calls preventDefault AND posts open-external when tryOpenLinkAt succeeds", () => {
    const doc = "see [t](https://example.com)";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 0);
    // Map coords to a pos inside the link's inline text (offset 5 = "[t]"+1).
    const view = makeMockView(state, () => 5);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(posted).toHaveLength(1);
    expect((posted[0] as { href: string }).href).toBe("https://example.com");
  });

  it("does NOT preventDefault and returns false when click hits plain text", () => {
    const doc = "just a paragraph";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 0);
    const view = makeMockView(state, () => 4);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("does NOT preventDefault for unsafe URL clicks (caret-fallthrough preserved)", () => {
    const doc = "see [t](javascript:alert(1))";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const event = makeMockEvent(/* button */ 0);
    const view = makeMockView(state, () => 5);
    const posted: WebviewToHost[] = [];
    const host: LinkOpenHost = { postMessage: (m) => posted.push(m) };
    expect(handleLinkMouseDown(event, view, host)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});

describe("quollLinkClickHandler — smoke (extension shape is valid)", () => {
  it("constructs and mounts without throwing", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const posted: WebviewToHost[] = [];
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "[link](https://example.com)",
        extensions: [
          markdown({ base: markdownLanguage }),
          quollLinkClickHandler({ postMessage: (m) => posted.push(m) }),
        ],
      }),
    });
    try {
      expect(view.state.doc.length).toBeGreaterThan(0);
      // Real coords-based mousedown synthesis would require layout, which
      // happy-dom does not provide. The branches above pin the helper
      // logic; this smoke only proves the extension wires.
    } finally {
      view.destroy();
    }
  });
});
