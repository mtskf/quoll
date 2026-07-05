# Changelog

All notable changes to Quoll are documented here.

## 0.1.x

- Add generous vertical space above headings so documents breathe like Notion and Obsidian instead of reading cramped. Each heading level gets a proportional gap above it — largest for H1, tapering down through H2, H3, and a shared smaller gap for H4–H6 — and the space scales with the body font. The very first line of a document and headings nested inside a blockquote or callout are left alone (they already have their own spacing). The fold chevron stays centred on the heading text, clicking into the new space lands the caret on the heading, and the Markdown round-trips byte-for-byte (display-only).
- Double the per-level indent of nested bullet lists so each level steps about 14px (a Notion/Obsidian feel) instead of the previous ~7px, which read too tight. The extra step applies to a bullet nested under a plain bullet — plain and task children step together, so mixed bullet/task sibling items stay left-aligned — while ordered lists, nesting under a task item, and blockquoted lists keep their existing spacing. Display-only: the raw Markdown is untouched and still round-trips byte-for-byte.
- Fix three block widgets — GFM tables, images, and the frontmatter metadata block — plus the bullet-list dot bleeding a few pixels past the paragraph text column. They now line up flush with body text on both edges: the table and image reserve the same text-column inset the blockquote and code panels already use, the frontmatter card is nudged in to match, and the bullet dot sits at the column edge. Display-only — the Markdown round-trips unchanged.
- Fix the caret not appearing in Quoll after switching from VS Code's built-in text editor. Moving the caret in the text editor and switching back to the Quoll tab now lands the cursor at the same position and shows it — the position was already carried across, but the cursor was never drawn because the rich editor had not taken focus. Selecting a range in the text editor transfers as a collapsed caret at the selection's head; the switch carries a single caret position in both directions by design.
- Fix the floating toolbar (outline and switch-editor buttons) not hiding on scroll. The toolbar animation was wired but had no visible effect — the element that actually scrolled was not `.cm-scroller` because the height chain above it was not bounded, so the scroll listener never fired. The editor is now bound to the viewport so `.cm-scroller` is the real scroller and the toolbar hides on scroll-down and returns on scroll-up as designed.
- Clarify and cover the external on-disk edit path with a regression test. A clean Quoll tab (no unsaved edits) correctly auto-updates when another tool — such as the Claude Code CLI — writes the file directly; the new test pins this `fs.writeFile` → VS Code watcher → auto-revert → reseed path end-to-end. A tab with unsaved edits does not auto-update: VS Code intentionally skips reverting dirty models to protect unsaved work. Workaround: save the tab first (or enable `files.autoSave`) so VS Code reconciles the external write.
- Ship releases on the Marketplace pre-release channel. The tag-triggered publish workflow and the deploy script now pass `--pre-release` (VS Code Marketplace and Open VSX), matching the local `pnpm package` script — 0.1.x builds are pre-releases, and stable-channel installs stay on 0.1.7 until the first deliberate stable release.
- Fix `⌘⌥E` (`Ctrl+Alt+E`) not switching from Quoll to the built-in text editor on macOS. On a Mac, Option+E is the acute-accent dead key, so the keydown never matched the editor's `Mod-Alt-e` chord; it now matches on the physical key — the same way VS Code matches the reverse text→Quoll direction — so both directions are symmetric. The top-right button and the Command Palette toggle were unaffected and still work.
- Fix the fold/unfold chevron alignment on list items. On a bullet, ordered, or task list item the chevron sat slightly above the item's first line — it didn't account for the vertical gap between list items — and now sits centred on that line at every nesting level and in both themes. Heading-fold chevrons are unchanged.
- Align the soft-wrapped continuation lines of bullet and ordered list items under the first line's text — they previously hung a few pixels to its left because the marker was approximated as a single space. The marker glyph column is now sized to closely match its rendered width, so wrapped lines land on the content column (bullet task items were already aligned and are unchanged; ordered task items are handled in a later entry below). The bullet dot also gains a slightly wider gap before the text.
- Fix a stray fold/unfold chevron appearing on GFM table rows. A table renders as a display-only block widget, not a foldable construct, so it now offers no fold affordance — top-level or nested inside a list item. Heading folds and genuine list folds are unaffected.
- Render thematic breaks (`---`, `***`, `___`) as a horizontal rule; move the caret onto the line to edit the raw source. Frontmatter fences and setext heading underlines are left untouched, and the bytes round-trip unchanged.
- Callouts now carry the per-type emoji as a small badge in the top-right corner, and the `[!TYPE]` marker line is tucked away whenever your caret is outside the callout — the block reads as a clean titled panel, and the editable `> [!TYPE]` source reappears the moment you move into it.
- Fix GFM tables nested inside a list item so they render as the editable grid instead of raw `| … |` source. A table indented as list-continuation content is now recognised (the same fix also covers top-level tables indented 1–3 spaces and tab-indented tables), and it still round-trips byte-for-byte.
- Make the fenced-code copy button icon-only at rest: drop the resting boxed background so it reads as a bare icon; the boxed hover/focus affordance and the copied/failed states are unchanged.
- Remove the leftover raised-key edge from the fenced-code copy button at rest: the native `<button>` bevel and any injected border/shadow are now explicitly neutralised, so the resting button is a truly flat bare icon. Hover, focus, copied, and failed states are unchanged.
- Restyle task-list checkboxes so open work leads the eye: incomplete items now show a green rounded ring, while completed items recede — a muted-grey filled box with a cut-out checkmark, and their text is dimmed (no strikethrough). The checkmark is re-centred, and in the light theme the todo ring uses a brighter green.
- Add a top-right button and an `Ctrl/Cmd+Alt+E` keybinding to switch the current `.md` between Quoll and VS Code's built-in text editor; the caret position is preserved across the switch (via the button and the chord; the reverse text→Quoll direction preserves it too).
- Tighten the task-list checkbox corner radius from 6px to 5px for a slightly crisper box.
- Make the floating outline and switch-editor buttons behave like a mobile-app toolbar: scrolling down slides them off the top edge, scrolling up brings them back, and they stay visible at the very top of the document. An open outline panel rides along so nothing is left floating, and the slide honours your "reduce motion" setting (it snaps instead). While hidden the toolbar is also kept out of the keyboard tab order for the whole slide, so focus can never land on an off-screen button.
- Align the soft-wrapped continuation lines of ordered task items (`1. [x] …`) under the first line's text. Their visible `N.` prefix was still sized as plain spaces, so wrapped lines hung a couple of pixels to the left (worse for multi-digit numbers); the number-and-dot glyph run is now sized to its rendered width like plain ordered lists. Bullet tasks (`- [ ]`, whose marker folds into the checkbox) are unchanged.
- Fix a stray fold/unfold chevron on a list item whose GFM table starts on the same physical line as the list marker (`- | a | b |`). The table renders as a block widget that covers the marker line, leaving the chevron nowhere sensible to sit, so it is now suppressed for that shape only. Genuine list folds — including a table on a later continuation line and plain multi-line items — and heading folds are unaffected.
- `Cmd+Option+K` (`Ctrl+Alt+K`) now auto-inserts the `@file#Lx-y` reference into the Claude Code you're actually using: the extension's composer when its sidebar or panel is visible, otherwise the CLI session connected via `/ide`. A text editor briefly flashes in place of Quoll (same pane, no layout shift) while the handoff is delivered, and the reference is also copied to the clipboard as insurance. When Claude Code isn't installed, the previous behaviour remains: copy to clipboard, surface Claude Code, and toast to paste.

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
