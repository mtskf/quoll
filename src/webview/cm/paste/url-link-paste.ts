import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { type AllowlistedUrl, isAllowedUrl } from "../../../markdown/url-allowlist.js";

// Ported verbatim from @codemirror/lang-markdown's built-in pasteURLAsLink: Lezer
// node names that mean the selection is NOT plain Markdown text, so wrapping a link
// into it would corrupt the construct (code, an existing link/image, emphasis
// marks, raw HTML, an autolink URL, …). Matched case-insensitively.
const nonPlainText =
  /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

/**
 * The clipboard text is a wrappable link target iff, after trimming, it is a
 * single whitespace-free token carrying an `http(s)://` scheme AND it passes the
 * shared allowlist hardening. Returns the trimmed URL, or null to defer.
 *
 * The `http(s)://` prefix test is a scheme gate, NOT a full-URL regex: `mailto:`
 * and bare relative refs also satisfy `isAllowedUrl`, but this feature targets
 * web links only (spec: non-http scheme → plain paste). `isAllowedUrl` still
 * owns the actual hardening (C0/DEL bytes, protocol-relative `//host`), so we do
 * not re-derive an ad-hoc URL validator here.
 */
export function detectPasteLinkUrl(clipboardText: string): AllowlistedUrl | null {
  const trimmed = clipboardText.trim();
  // Exactly one token: any interior whitespace/newline means it is not a bare URL.
  if (trimmed === "" || /\s/.test(trimmed)) {
    return null;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (!isAllowedUrl(trimmed)) {
    return null;
  }
  return trimmed;
}

// Budget for parsing the syntax tree up to the selection before the guard walk.
// A selection already in the viewport is cached so ensureSyntaxTree returns
// instantly; only a genuinely unparsed (far-off) selection spends time, and if
// the budget is exhausted the guard fails closed (see selectionIsPlainText).
const GUARD_PARSE_BUDGET_MS = 50;

/**
 * Port of the built-in pasteURLAsLink guard, hardened: the wrap is only safe
 * when the selection sits in ACTIVE plain Markdown text. Refuses when the
 * Markdown language is not active at the anchor, or when the selected range
 * crosses a node boundary or sits inside a non-plain-text construct (code, an
 * existing link/image, emphasis marks, raw HTML, an autolink). Without this a
 * URL pasted over a selection inside inline/fenced code, a link, or emphasis
 * would inject `[..](url)` into that construct.
 *
 * The built-in walked `syntaxTree(view.state)` directly, which in a large or
 * freshly-opened document may only be parsed to the viewport frontier — a
 * selection beyond it would walk zero nodes, look like plain text, and wrap into
 * code anyway. We `ensureSyntaxTree` up to the selection first and FAIL CLOSED
 * (defer) when the tree can't be produced within the budget, so an unclassified
 * selection is never wrapped.
 */
export function selectionIsPlainText(state: EditorState, from: number, to: number): boolean {
  if (!markdownLanguage.isActiveAt(state, from, 1)) {
    return false;
  }
  const tree = ensureSyntaxTree(state, to, GUARD_PARSE_BUDGET_MS);
  if (tree === null) {
    return false; // tree unavailable for the selection → can't verify → defer
  }
  let crossesNode = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.from > from || nonPlainText.test(node.name)) {
        crossesNode = true;
      }
    },
    leave: (node) => {
      if (node.to < to) {
        crossesNode = true;
      }
    },
  });
  return !crossesNode;
}

/**
 * Render the URL as a CommonMark link destination. A bare destination allows
 * BALANCED parens (CommonMark tracks depth, so `…/Foo_(bar)` round-trips fine),
 * but an UNBALANCED `)` — e.g. `…/foo)bar` — closes the destination early,
 * truncating the URL and leaking the tail as text. Rather than compute paren
 * balance, conservatively angle-bracket the URL whenever it carries any paren;
 * angle-bracket destinations read literally up to `>`. Guarded on the absence of
 * `<`/`>` — bytes that never appear unencoded in a real http(s) URL and that
 * would themselves break the angle form; such a value falls back to the bare
 * destination.
 */
function linkDestination(url: string): string {
  return /[()]/.test(url) && !/[<>]/.test(url) ? `<${url}>` : url;
}

/** Capture the URL and label range; rendering does not retain the view. */
export function decideUrlPaste(state: EditorState, text: string) {
  const { from, to, empty } = state.selection.main;
  if (empty || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
    return null;
  }
  const url = detectPasteLinkUrl(text);
  if (url === null || !selectionIsPlainText(state, from, to)) {
    return null;
  }
  return {
    from,
    to,
    url,
    render: (live: EditorState, start: number, end: number) =>
      live.doc.lineAt(start).number === live.doc.lineAt(end).number &&
      selectionIsPlainText(live, start, end)
        ? `[${live.doc.sliceString(start, end)}](${linkDestination(url)})`
        : text,
  };
}
