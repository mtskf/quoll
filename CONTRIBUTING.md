# Contributing to Quoll

Thanks for your interest in Quoll — a VS Code custom editor that opens `.md`
files in a Notion- and Obsidian-style WYSIWYG surface, with the raw Markdown
text kept as the single source of truth.

## Prerequisites

- **Node.js 20+**
- **pnpm** — this is a pnpm-only project. A stray `package-lock.json` is
  rejected on purpose; do not use `npm` or `yarn` to install.
  (`corepack enable` will pick up the pinned pnpm version.)
- **VS Code 1.94+**

## Setup

```bash
pnpm install
```

## Build

```bash
pnpm build          # type-check (host + webview) + esbuild → dist/
pnpm watch          # esbuild in watch mode while you develop
```

`pnpm build` runs `tsc` type-checks for the host and webview, then bundles via
esbuild into `dist/`:

- `dist/extension.cjs` — extension host bundle (Node CJS)
- `dist/webview/index.{js,css}` — webview bundle (browser ESM)

## Run it locally

- In VS Code, press **F5** ("Run Extension") to launch an Extension Development
  Host with Quoll loaded, then open any `.md` file via **Open With… → Markdown
  (Quoll)**.
- Or build and install a `.vsix`:

  ```bash
  pnpm package                                    # → quoll-<version>.vsix
  code --install-extension quoll-<version>.vsix --force
  ```

Quoll registers with `priority: option`, so it never hijacks `.md` from other
Markdown extensions — you opt in per file.

## Tests & checks

Please make sure these pass before opening a PR:

```bash
pnpm compile        # type-check all sources (no emit)
pnpm lint           # Biome: lint + format + assist (read-only)
pnpm test           # unit (vitest) + e2e (@vscode/test-electron)
```

`pnpm check` applies Biome auto-fixes in place. `pnpm test:unit` and
`pnpm test:e2e` run the two suites individually.

## Architecture (where things live)

Quoll is a **two-process** extension:

- **Extension host** (`src/extension/`) owns the `TextDocument`, validates every
  incoming edit, and writes back via `WorkspaceEdit` — VS Code remains the
  single source of truth on disk.
- **Webview** (`src/webview/`) renders the editor. The canonical text layer is
  **CodeMirror 6** over raw Markdown; rich constructs (headings, tables, code
  blocks, images…) render as live decorations and block widgets over that text.
- The two sides talk only through the versioned `postMessage` protocol in
  `src/shared/protocol.ts`.

The host-side Markdown layer (`src/markdown/`) is validation + pure data models
only (write-gate, URL allowlist, GFM table model, frontmatter).

**Design guardrail:** Quoll ships exactly **one** editing surface (CodeMirror).
Please do not introduce a second runtime editor (e.g. a ProseMirror fallback or
a per-document "old editor" toggle) — the intended rollback path is pinning an
older `.vsix`, not switching editors at runtime.

## Pull requests

- **One PR = one purpose.** Touch only files relevant to the change; keep
  unrelated refactors out.
- Write commit messages and code comments in **English**; documentation should
  explain the *why*.
- **New dependencies are default-deny.** If a PR adds a package, justify it in
  the description (what it does, weekly downloads, last release, maintainer,
  and why a small in-house primitive won't do). Runtime deps are currently
  `@codemirror/*` + `@lezer/*` only — keep that surface small.
- Keep the change type-checking, linting, and testing green (see above).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
