// @vitest-environment happy-dom
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { validateMarkdownForWrite } from "../../../src/markdown/validate-for-write.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { detectPasteLinkUrl, pasteUrlOverSelection } from "../../../src/webview/cm/paste/index.js";

describe("detectPasteLinkUrl — URL detection boundary", () => {
  it("accepts a bare http(s) URL (trimming surrounding whitespace)", () => {
    expect(detectPasteLinkUrl("https://example.com")).toBe("https://example.com");
    expect(detectPasteLinkUrl("http://example.com/a?b=1#c")).toBe("http://example.com/a?b=1#c");
    expect(detectPasteLinkUrl("  https://example.com  ")).toBe("https://example.com");
    // Scheme match is case-insensitive; the original casing is preserved.
    expect(detectPasteLinkUrl("HTTPS://Example.com")).toBe("HTTPS://Example.com");
  });

  it("rejects a URL with trailing text (not a single token)", () => {
    // THE key spec boundary: `URL + trailing text` must stay a plain paste.
    expect(detectPasteLinkUrl("https://example.com trailing")).toBeNull();
    expect(detectPasteLinkUrl("see https://example.com")).toBeNull();
  });

  it("rejects any interior whitespace / newline", () => {
    expect(detectPasteLinkUrl("https://example.com\nfoo")).toBeNull();
    expect(detectPasteLinkUrl("https://exa mple.com")).toBeNull();
    // trailing \t is stripped by trim() → still a single token
    expect(detectPasteLinkUrl("https://example.com\t")).toBe("https://example.com");
  });

  it("rejects empty / whitespace-only text", () => {
    expect(detectPasteLinkUrl("")).toBeNull();
    expect(detectPasteLinkUrl("   ")).toBeNull();
  });

  it("rejects a non-http(s) scheme (aligns with the http(s)-only target)", () => {
    expect(detectPasteLinkUrl("mailto:a@b.com")).toBeNull(); // allowlisted, but not a web link
    expect(detectPasteLinkUrl("ftp://host/x")).toBeNull();
    expect(detectPasteLinkUrl("xmpp:foo@bar")).toBeNull();
    expect(detectPasteLinkUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects a schemeless / relative token (would pass isAllowedUrl as relative)", () => {
    expect(detectPasteLinkUrl("example.com")).toBeNull();
    expect(detectPasteLinkUrl("foo/bar.md")).toBeNull();
    expect(detectPasteLinkUrl("#anchor")).toBeNull();
  });

  it("rejects protocol-relative and control-byte forms (shared allowlist hardening)", () => {
    expect(detectPasteLinkUrl("//evil.com/x")).toBeNull(); // no http prefix + protocol-relative
    // A C0 byte (not whitespace) survives trim + the whitespace/scheme checks but
    // is rejected by isAllowedUrl's raw-value control-char guard.
    expect(detectPasteLinkUrl(`https://exa${String.fromCharCode(1)}mple.com`)).toBeNull();
  });
});

// --- Handler ---

// The Markdown language is mounted so the handler's syntax-context guard
// (`markdownLanguage.isActiveAt` + the syntaxTree walk) is exercised. The
// ensureSyntaxTree call is a best-effort, time-budgeted warm-up so the tree is
// populated at paste time (the handler self-ensures too, so this is a warm-up,
// not load-bearing).
function mount(doc: string, anchor: number, head: number, canWrite = true): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [
        quollMarkdownLanguage(),
        EditorState.readOnly.of(!canWrite),
        history(),
        pasteUrlOverSelection({ canWrite: () => canWrite }),
      ],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

function firePaste(view: EditorView, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("pasteUrlOverSelection — handler", () => {
  it("wraps a single-line selection as a link and consumes the event", () => {
    const view = mount("select me", 0, "select".length); // select "select"
    const event = firePaste(view, "https://example.com");
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("[select](https://example.com) me");
    view.destroy();
  });

  it("wraps as exactly ONE undo step (single dispatch)", () => {
    const view = mount("select me", 0, "select".length);
    firePaste(view, "https://example.com");
    expect(view.state.doc.toString()).toBe("[select](https://example.com) me");
    undo(view); // one undo restores the pre-paste document
    expect(view.state.doc.toString()).toBe("select me");
    view.destroy();
  });

  // Defer cases: our handler returns false, so CM's OWN core paste handler runs
  // (and preventDefaults for its own clipboard insert) — `defaultPrevented` is
  // therefore an unreliable signal here. The behavioural contract under test is
  // "no link wrap occurred", i.e. the document never gains `](` link syntax.
  it("defers plain paste when there is no selection (empty range)", () => {
    const view = mount("hello", 5, 5); // caret, no selection
    firePaste(view, "https://example.com");
    expect(view.state.doc.toString()).not.toContain("]("); // no link wrap
    view.destroy();
  });

  it("defers plain paste for a multi-line selection", () => {
    const view = mount("line one\nline two", 0, "line one\nline".length); // spans the newline
    firePaste(view, "https://example.com");
    expect(view.state.doc.toString()).not.toContain("](");
    view.destroy();
  });

  it("defers plain paste for a URL with trailing text (spec boundary)", () => {
    const view = mount("select me", 0, "select".length);
    firePaste(view, "https://example.com and more");
    expect(view.state.doc.toString()).not.toContain("](");
    view.destroy();
  });

  it("defers plain paste for non-URL text over a selection", () => {
    const view = mount("select me", 0, "select".length);
    firePaste(view, "just some text");
    expect(view.state.doc.toString()).not.toContain("](");
    view.destroy();
  });

  it("swallows the paste in a read-only editor without wrapping", () => {
    const view = mount("select me", 0, "select".length, false);
    const event = firePaste(view, "https://example.com");
    expect(event.defaultPrevented).toBe(true); // committed to wrapping, then swallowed
    expect(view.state.doc.toString()).toBe("select me"); // no insert
    view.destroy();
  });

  it("angle-brackets any paren-bearing URL (balanced Wikipedia case)", () => {
    // Balanced parens round-trip fine in a bare destination, but we bracket ANY
    // paren conservatively rather than compute balance. Pin the bracketing.
    const view = mount("Foo", 0, "Foo".length);
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    firePaste(view, url);
    const doc = view.state.doc.toString();
    expect(doc).toBe(`[Foo](<${url}>)`);
    // …and the result is accepted by the host write-gate (never rejected).
    expect(validateMarkdownForWrite(`${doc}\n`).ok).toBe(true);
    view.destroy();
  });

  it("angle-brackets an UNBALANCED-paren URL so it is not truncated", () => {
    // The real corruption case: a lone `)` closes a bare CommonMark destination
    // early. Angle brackets keep the whole URL as the destination.
    const view = mount("Foo", 0, "Foo".length);
    const url = "https://example.com/a)b";
    firePaste(view, url);
    const doc = view.state.doc.toString();
    expect(doc).toBe(`[Foo](<${url}>)`);
    expect(validateMarkdownForWrite(`${doc}\n`).ok).toBe(true);
    view.destroy();
  });
});

// Syntax-context guard (ported from the built-in pasteURLAsLink): a URL is NEVER
// wrapped into a non-plain-text construct. Wrapping `](url)` into inline/fenced
// code, an existing link, etc. would corrupt it, so the handler defers.
describe("pasteUrlOverSelection — syntax-context guard", () => {
  it("defers when the selection is inside an inline code span", () => {
    const view = mount("`code`", 1, 5); // select "code" between the backticks
    firePaste(view, "https://example.com");
    expect(view.state.doc.toString()).not.toContain("]("); // no wrap injected into code
    view.destroy();
  });

  it("defers when the selection is inside a fenced code block", () => {
    const doc = "```\ncode\n```";
    const view = mount(doc, doc.indexOf("code"), doc.indexOf("code") + 4);
    firePaste(view, "https://example.com");
    expect(view.state.doc.toString()).not.toContain("](");
    view.destroy();
  });

  it("defers when the selection is inside an existing link label", () => {
    const doc = "[label](https://x.com)";
    const view = mount(doc, 1, 6); // select "label"
    firePaste(view, "https://example.com");
    // The doc starts with exactly one `](` (the existing link). A wrap regression
    // would inject a SECOND one; a plain-paste defer leaves the count at one
    // (regardless of whether CM core replaces the selection text).
    const count = view.state.doc.toString().split("](").length - 1;
    expect(count).toBe(1);
    view.destroy();
  });
});

// NOTE: the handler's parse-frontier hardening (`ensureSyntaxTree` + fail-closed
// in selectionIsPlainText) is not unit-tested here. In happy-dom the syntax tree
// is parsed synchronously regardless of the mount's prewarm, so the "selection
// beyond the parse frontier" race the fix guards against cannot be reproduced
// deterministically (a probe test passed identically with and without the fix).
// The fix is a defensive robustness improvement over the ported built-in; the
// tree-available guard behaviour is covered by the code/link defer tests above.
