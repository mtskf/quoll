# Quoll

Edit Markdown in VS Code with a Notion- and Obsidian-style WYSIWYG editor, right inside your editor tabs.

Quoll registers an opt-in custom editor for `.md` files. Instead of plain text, your Markdown renders as rich text — headings, lists, tables, and formatting — while the file on disk stays the source of truth.

## Features

- **WYSIWYG Markdown editing** — opens `.md` files in a CodeMirror-based live editor: the raw Markdown stays canonical while headings, lists, tables, images, and formatting render in place. Move the caret into a construct to reveal and edit its Markdown source.
- **Live sync to disk** — edits are written back to the document as you type; VS Code owns the file and remains the single source of truth.
- **Tables** — render and edit GFM tables already present in the Markdown source.
- **Theme-aware** — follows your VS Code light/dark color theme.
- **Opt-in, non-intrusive** — registered with `priority: option`, so it never hijacks `.md` files from other Markdown extensions. You choose it per file via "Open With…", or set it as your default.

## Requirements

- VS Code `1.94.0` or newer.
- A trusted, local workspace. Quoll writes files via `WorkspaceEdit` and does not support untrusted or virtual workspaces.

## Install

Quoll is not on the Marketplace yet. To try it, build and install the `.vsix` from source:

```bash
git clone https://github.com/mtskf/quoll.git
cd quoll
pnpm install
pnpm package        # produces quoll-<version>.vsix
code --install-extension quoll-*.vsix
```

Reload the VS Code window after installing.

## Usage

`.md` files keep opening in your usual editor by default. Open one in Quoll explicitly:

- **Per file:** right-click a Markdown file → **Open With…** → **Markdown (Quoll)**.
- **As the default:** right-click → **Open With…** → **Configure default editor…** → pick **Markdown (Quoll)**.
- **From the palette:** run **Edit with Quoll** (`Ctrl/Cmd+Shift+P`) to open the active file in Quoll.

### Commands and keybindings

| Command          | Title           | Notes                                          |
| ---------------- | --------------- | ---------------------------------------------- |
| `quoll.editWith` | Edit with Quoll | Opens the active file in the Quoll editor.     |

Inline formatting is plain Markdown — type `**bold**`, `*italic*`, or
`` `code` `` and the editor live-renders it. Move the caret into a
construct to reveal its raw Markdown markers for editing; move the caret
away to re-render. This live-reveal is editor-internal behavior rather than
a set of VS Code commands, so it does not appear in the keybindings UI.

## Settings

Quoll contributes two settings (Settings UI → search "Quoll", or `settings.json`):

- `quoll.lint.problems.enabled` (default `true`) — mirror Quoll's advisory
  Markdown lint findings into VS Code's **Problems** panel. Turning it off
  clears those entries and suppresses new ones; the in-editor underlines stay on.
- `quoll.lint.gutter.enabled` (default `false`) — show a severity-coloured dot
  in a thin left gutter on each line that has an advisory lint finding. Off by
  default so the clean centred reading column is unchanged; turning it on adds
  the gutter without touching the underlines or the Problems mirror.

## Known limitations

Quoll is early software. Be aware of the following before relying on it:

- **Markdown round-trips byte-for-byte.** Because the raw text is canonical, text in equals text on disk for every construct, including CRLF line endings. Two caveats: a document that *mixes* CRLF and LF, or is CR-only, is shown with a single, normalized line separator — VS Code normalizes line endings when it loads a file, and Quoll re-asserts that one separator at the editor boundary, so the editor only ever sees and round-trips uniform line endings. Opening such a file and saving it without edits leaves the original bytes on disk unchanged. And a document is refused by the write-gate — and not saved until fixed — when a Markdown link/image/autolink destination falls outside the allowed set (a relative path, a fragment, or an `http:`/`https:`/`mailto:` URL — see Images below), surfaced as a "Cannot save" notice.
- **Raw HTML is shown as inert source.** Raw HTML inside Markdown is displayed as its source rather than rendered as live HTML, but it is preserved byte-for-byte on save. Open the file with the default text editor if you want raw-HTML syntax highlighting.
- **Images have partial support.** Standalone relative-path images (`![](./img.png)`) resolve against the document folder and render for **file-scheme** documents only; untitled and git-scheme documents leave them as inert placeholders. Pasting or dropping an image into a writable file-scheme document saves it under `./assets/` as a content-hashed PNG/JPEG/GIF/WebP (10 MB cap, type sniffed host-side, never trusting the source) and inserts a relative link; read-only documents ignore the paste. Images outside the document's folder tree (e.g. `../sibling/img.png`) are not loaded — `localResourceRoots` is scoped to the document folder only, so VS Code refuses the fetch. Remote (`https://…`) images remain CSP-blocked pending a dedicated opt-in — no `img-src` widening was needed because `${cspSource}` already authorises `asWebviewUri` local resources. Canonical Markdown is never mutated for display (byte-identical round-trip). URL safety is a scheme-name **allowlist**: a Markdown link/image/autolink destination passes when it has no scheme (a relative path or a `#fragment`) or its scheme is `http:`, `https:`, or `mailto:`. Every other scheme (`javascript:`, `data:`, `file:`, `ftp:`, …), a protocol-relative `//host`, and any control-character-bearing URL is rejected: it renders an inert placeholder (no request is ever made), and the host write-gate refuses to save the whole document until it is fixed (fail-closed; you get a "Cannot save" notice rather than a silent write). The check is by scheme name, not full URL validation, and it covers Markdown link/image/autolink destinations only — URLs written inside raw HTML are not checked (raw HTML is rendered as inert source). An explicit remote-image opt-in and an inline `data:` policy are tracked for a follow-up release.
- **MDX (`.mdx`) is not supported** — only `.md` files open with the rich editor.
- **Not implemented:** slash/block-insert menu (no UI to insert tables / lists / headings from scratch), column resizing for tables, table of contents, diff/git views, and collaborative editing. Single file, single editor only.
- **Visual rendering is verified by manual smoke.** Automated tests cover the CodeMirror decoration/widget behavior, GFM table round-trips, the host write-gate, the message protocol, and host-side message flows (a `@vscode/test-electron` E2E suite); in-webview visual rendering is not asserted by CI and is checked by manual smoke.

## Contributing

Contributions are welcome. The project is a single-root pnpm package (extension host + webview bundled together via esbuild).

```bash
pnpm install        # install all deps
pnpm build          # full build (tsc + esbuild → dist/)
pnpm package        # produce a .vsix via vsce
pnpm test           # run the vitest unit suite
```

Press `F5` in VS Code to launch an Extension Development Host with Quoll loaded. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## License

[MIT](LICENSE) — © 2026 Mitsuki Fukunaga and Quoll contributors.
