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
// write-/render-gates. The insert rides the normal dispatch → updateListener →
// edit-sync → host write-lock → validateMarkdownForWrite pipeline (no raw write).

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { isAllowedUrl } from "../../../markdown/url-allowlist.js";

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
export function detectPasteLinkUrl(clipboardText: string): string | null {
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

// TODO(dedupe): unify with the Cmd+K link-wrap helper from
// feat/inline-formatting-shortcuts once merged.
/**
 * Wrap the main selection as `[selection](url)` in ONE dispatch (a single undo
 * step). Two point-insertions bracket the selected text so the label is
 * preserved verbatim and CM maps the selection through the changes. The caller
 * guarantees a non-empty single-line main range.
 */
function insertLinkOverSelection(view: EditorView, url: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: [
      { from, insert: "[" },
      { from: to, insert: `](${url})` },
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
