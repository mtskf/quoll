// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../src/shared/protocol.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { quollLinkClickHandler, tryOpenLinkAt } from "../../src/webview/cm/link-handlers.js";

function mount(doc: string, host: { postMessage(m: WebviewToHost): void }): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        quollLinkClickHandler(host),
      ],
    }),
  });
}

describe("C4b integration — identity round-trip", () => {
  it("doc bytes survive caret-in / caret-out cycles across multiple links", () => {
    // Trailing `" tail"` keeps `original.length` OUTSIDE the last link's range. Without it, `[d]`
    // sat at the very end so `link.to === original.length`, and the
    // boundary-inclusive `selectionIntersects` judged the caret at
    // `original.length` as REVEALED (inside the boundary) — the intended
    // "caret AFTER every link" case became a "caret AT every link's
    // boundary" case. The identity assertion still held (positions don't
    // mutate the doc) but the comment "after every link" was inaccurate.
    const original =
      "Intro [a](https://example.com) middle [b](mailto:b@b.com) end\n" +
      "Second line [c](http://x) and [d](/relative) tail";
    const posted: WebviewToHost[] = [];
    const view = mount(original, { postMessage: (m) => posted.push(m) });
    try {
      // Marker-based positions: walk the caret through positions known to
      // sit inside each link's
      // inline content + before-all and after-all positions, asserting
      // doc bytes are byte-identical at every step. Marker-based indexing
      // is robust against doc reflows; the earlier draft's fixed numeric
      // positions [0, 8, 32, 60, 95, 100, length] mis-described what they
      // hit (32 and 60 sat between links, not inside content).
      const positions = [
        0, // before any link
        original.indexOf("[a]") + 1, // inside link a content
        original.indexOf("[b]") + 1, // inside link b content
        original.indexOf("[c]") + 1, // inside link c content
        original.indexOf("[d]") + 1, // inside link d content
        original.length, // after every link
      ];
      for (const pos of positions) {
        view.dispatch({ selection: EditorSelection.single(pos) });
        expect(view.state.sliceDoc()).toBe(original);
      }
    } finally {
      view.destroy();
    }
  });
});

describe("C4b integration — URL-security matrix at the click gate", () => {
  // Each row pairs an unsafe URL with a label. tryOpenLinkAt MUST refuse
  // to post for every row.
  const unsafe: Array<[string, string]> = [
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript backslash colon", "javascript\\:alert(1)"],
    ["javascript via numeric entity", "javascript&#58;alert(1)"],
    ["javascript via hex entity", "javascript&#x3A;alert(1)"],
    ["javascript via named entity", "javascript&colon;alert(1)"],
    ["javascript via surrogate substitute", "javascript&#xD800;:alert(1)"],
    ["data:text/html", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative slash", "//evil.example/x"],
    ["protocol-relative backslash", "\\\\evil.example/x"],
    // Kept symmetric with the host matrix (Task 2) and the webview unit
    // matrix (Task 7) so the DRIFT WARNING invariant (both matrices
    // cover the same hostile-URL attack-scenario set) stays in sync.
    // (The two C0-bypass rows — inline `java&#10;script:...` and
    // trailing `...example.com&#10;` — deliberately differ by protocol
    // design: this matrix passes the raw entity form `&#10;`, the host
    // matrix passes the post-decode literal `\n` — so the matrices are
    // not byte-identical, just attack-equivalent.)
    ["vbscript scheme", "vbscript:msgbox"],
    // The earlier draft used `"java\\nscript:alert(1)"` (literal backslash
    // + n, ~6 bytes) which did NOT exercise the C0 bypass —
    // decodeMarkdownDestination leaves
    // `\n` alone (the CommonMark §2.4 backslash-escape regex only matches
    // ASCII punctuation; `n` is not in the set), so isAllowedUrl's
    // scheme regex fell through to "relative path, accept" and the test
    // passed for the WRONG reason. The numeric entity `&#10;` decodes to
    // a literal LF byte that isAllowedUrl's C0 regex
    // (`[\u0000-\u001f\u007f]`) actually catches — pinning the real
    // bypass.
    ["C0 control bypass (numeric entity)", "java&#10;script:alert(1)"],
    // Trailing-C0 bypass (review-cycle 1 C1): symmetric with the
    // host matrix and the webview unit matrix. `&#10;` decodes to LF;
    // pre-fix trim-before-check order would have stripped it and
    // accepted the URL.
    ["trailing C0 via entity (&#10;)", "https://example.com&#10;"],
  ];

  for (const [label, url] of unsafe) {
    it(`renders INERT (no postMessage) on click for ${label}`, () => {
      // `"prefix "` (7 chars) keeps the default caret at 0 OUTSIDE the
      // Link's revealed-guard range. A future row added with a shorter
      // prefix would re-introduce the vacuous-test bug; convention:
      // prefix MUST be ≥ 1 non-link char, and the caret stays at the
      // default position 0. The Task 7 unit tests use the shorter
      // `"see "` (4 chars); both keep `link.from ≥ prefix.length` so
      // caret 0 is outside.
      const doc = `prefix [t](${url}) suffix`;
      const posted: WebviewToHost[] = [];
      const view = mount(doc, { postMessage: (m) => posted.push(m) });
      try {
        // Click position: inside the link's inline content (`t` at
        // doc.indexOf("[t]") + 1).
        const pos = doc.indexOf("[t]") + 1;
        const handled = tryOpenLinkAt(view.state, pos, { postMessage: (m) => posted.push(m) });
        expect(handled).toBe(false);
        expect(posted).toEqual([]);
      } finally {
        view.destroy();
      }
    });
  }

  it("a safe https link DOES post open-external", () => {
    // `"see "` prefix: mount() sets the default selection at 0; without
    // the prefix the Link at [0, 27) would
    // trigger tryOpenLinkAt's revealed-guard and the assertion would
    // fail.
    const doc = "see [link](https://example.com)";
    const posted: WebviewToHost[] = [];
    const view = mount(doc, { postMessage: (m) => posted.push(m) });
    try {
      const handled = tryOpenLinkAt(view.state, doc.indexOf("[link]") + 1, {
        postMessage: (m) => posted.push(m),
      });
      expect(handled).toBe(true);
      expect(posted).toEqual([
        { protocol: PROTOCOL_VERSION, type: "open-external", href: "https://example.com" },
      ]);
    } finally {
      view.destroy();
    }
  });
});
