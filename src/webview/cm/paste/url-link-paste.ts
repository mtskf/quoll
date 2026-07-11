// CodeMirror paste handler: pasting a single plain http(s) URL while a non-empty
// single-line selection exists wraps the selection as a Markdown link
// `[selection](url)` (Notion / Obsidian behaviour). Every other paste defers —
// the handler returns `false` (without preventDefault) so htmlTablePaste, the
// image paste pipeline (image-paste.ts), and CM's default plain-text paste run.
//
// This REPLACES @codemirror/lang-markdown's built-in `pasteURLAsLink` (dropped
// from quollMarkdownLanguage in markdown.ts). The built-in matched URLs by
// PREFIX (`/^(https?:\/\/|mailto:|xmpp:|www\.)/`), so `https://x.com trailing`
// over a selection was wrongly wrapped, and `xmpp:` / `www.` / `mailto:` schemes
// outside Quoll's url-allowlist were accepted. Ours requires the clipboard text
// to be EXACTLY one http(s) URL token and reuses the shared `isAllowedUrl`
// hardening (C0/DEL, protocol-relative) so paste stays in lockstep with the
// write-/render-gates. It KEEPS the built-in's syntax-context guard
// (`selectionIsPlainText`) so a URL is never wrapped into code / an existing
// link / emphasis / raw HTML. The insert rides the normal dispatch →
// updateListener → edit-sync → host write-lock → validateMarkdownForWrite
// pipeline (no raw write).

import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
function selectionIsPlainText(view: EditorView, from: number, to: number): boolean {
  if (!markdownLanguage.isActiveAt(view.state, from, 1)) {
    return false;
  }
  const tree = ensureSyntaxTree(view.state, to, GUARD_PARSE_BUDGET_MS);
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

// TODO(dedupe): unify with the Cmd+K link-wrap helper from
// feat/inline-formatting-shortcuts once merged.
/**
 * Wrap the main selection as `[selection](url)` in ONE dispatch (a single undo
 * step). Two point-insertions bracket the selected text so the label is
 * preserved verbatim and CM maps the selection through the changes. The caller
 * guarantees a non-empty single-line main range in plain Markdown text.
 */
function insertLinkOverSelection(view: EditorView, url: AllowlistedUrl): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: [
      { from, insert: "[" },
      { from: to, insert: `](${linkDestination(url)})` },
    ],
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

export function pasteUrlOverSelection(opts: { canWrite: () => boolean }): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const { main } = view.state.selection;
        // No selection → nothing to wrap; defer to plain paste / other handlers.
        if (main.empty) {
          return false;
        }
        // Single-line only: a multi-line selection is a block operation, not a
        // link label. Defer to plain paste.
        const startLine = view.state.doc.lineAt(main.from).number;
        const endLine = view.state.doc.lineAt(main.to).number;
        if (startLine !== endLine) {
          return false;
        }
        const text = event.clipboardData?.getData("text/plain");
        if (!text) {
          return false;
        }
        const url = detectPasteLinkUrl(text);
        if (url === null) {
          return false; // not a bare http(s) URL → normal paste
        }
        // Don't wrap inside code / an existing link / emphasis / raw HTML —
        // mirrors the built-in pasteURLAsLink guard we replaced.
        if (!selectionIsPlainText(view, main.from, main.to)) {
          return false;
        }
        // preventDefault ONLY here, AFTER we commit to wrapping (mirrors
        // htmlTablePaste): moving it earlier would swallow non-URL pastes.
        event.preventDefault();
        // Read-only: swallow silently with NO fallback insert. canWrite() is the
        // same source that drives EditorState.readOnly, so they cannot diverge.
        if (!opts.canWrite()) {
          return true;
        }
        insertLinkOverSelection(view, url);
        return true;
      },
    })
  );
}
