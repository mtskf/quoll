# Changelog

All notable changes to Quoll are documented here.

## 0.1.0 — Initial public release

Quoll opens Markdown files in a Notion- and Obsidian-style WYSIWYG editor,
right inside VS Code. Raw Markdown stays the single source of truth — every
construct round-trips byte-for-byte — while the editor renders it live.

Highlights:

- Live Markdown rendering with reveal-on-caret: headings, blockquotes, inline
  emphasis, links, and code render in place; move the caret onto a construct to
  edit its raw source.
- Fenced code blocks on a rounded, syntax-aware panel with a copy-to-clipboard
  button, auto-closing fences on Enter, and automatic collapse for long blocks.
- Blockquote callouts with GitHub/Obsidian admonition types (`[!NOTE]`,
  `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) and nested-quote tinting.
- GFM tables rendered as editable grids: click a cell to edit in place, keyboard
  navigation, and structural row/column edits, with full IME support.
- Task lists with interactive checkboxes, and clean outline indentation for
  nested bullet, ordered, and task lists.
- Standalone images render inline; paste or drop an image to save it under
  `./assets/` and insert a relative link.
- YAML frontmatter renders as a quiet metadata block — click or arrow into it to
  edit the source.
- Document outline / heading navigator.
- Advisory Markdown lint surfaced as in-editor underlines, with an optional
  Problems-panel mirror, an opt-in gutter, and an opt-in trailing-whitespace
  quick fix. Lint is advisory only — it never blocks a save or rewrites bytes.
- Caret position carries across switching between Quoll and the default text
  editor; one-key handoff of the current file or selection to Claude Code or Codex.
- Theme-aware styling for light, dark, and high-contrast themes.

Security: a host-side write gate validates every save (URL allowlist,
frontmatter round-trip), and image and link destinations are gated so rendering
and writing stay in lockstep. The editor webview runs under a default-deny CSP
(`base-uri`/`form-action` locked down), and relative image paths that traverse
above the document's folder — standalone or inside a table cell — render as an
inert placeholder.
