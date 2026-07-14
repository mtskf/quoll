# Webview preview harness (dev-only)

A permanent, real-Chromium harness for inspecting the Quoll webview's CSS and
widget rendering. It bundles the **real** `dist/webview` and serves it over http
so you can open it in an actual browser (Chrome/Chromium), then eyeball layout or
probe it with `getComputedStyle` / `getBoundingClientRect`.

Why it exists: happy-dom has no layout engine and drops some CSS (e.g. negative
`calc()` `text-indent`), so a whole class of bugs — proportional-font-measured
list indent, block-widget geometry, scroll behaviour — is invisible in unit
tests. This is the committed successor to the ephemeral scratchpad harness that
had to be rebuilt every session. See the LEARNING.md entry _"real-browser preview
harness"_ and the memory `[[quoll-webview-css-bug-real-browser-harness]]`.

No new dependencies: it uses Node built-ins plus the `esbuild` already in the
repo, and reuses `createBuildConfigs` from `esbuild.config.mjs` so the served
bundle is byte-faithful to the shipped `.vsix` (no duplicated loader/define).

## Usage

```bash
pnpm preview                                   # build + serve; open the printed URL
pnpm preview test/markdown/fixtures/gfm-table.md   # override the fixture for this run
```

On start it prints `http://localhost:4599/`. Open it in Chrome. Flags:

| Flag             | Default                             | Effect                                             |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `[doc]` (positional) | `preview.config.mjs` `doc`      | Render this markdown file instead of the config's. |
| `--port <n>`     | `4599`                              | Listen port. On `EADDRINUSE`, increments up to 10× |
| `--config <path>`| `scripts/preview/preview.config.mjs`| Alternate config module.                           |
| `--no-build`     | (build)                             | Skip the esbuild step and reuse existing `dist/webview`. |

## Visual smoke (`pnpm smoke:visual`)

`visual-smoke.mjs` drives this harness in **headless Chromium** (via `playwright`, already a
devDependency — no new deps) to automate the *render-appearance* half of the manual visual smoke:

```bash
pnpm smoke:visual
```

It builds the real bundle, serves the combined fixture `scripts/preview/fixtures/visual-smoke.md`
(the single source of truth the HUMAN smoke entry in `.claude/docs/TODO.md` points to) on an
**ephemeral port** in light + dark, and asserts one DOM / `getComputedStyle` check per construct:
frontmatter block, table (escaped `\|` stays in one cell), task checkboxes, allowlisted `<img>` vs an
inert `javascript:` placeholder, fenced code + its collapse bar, and the per-theme `<html>` class.

Screenshots land in `artifacts/visual-smoke/` (`light.png`, `dark.png`, `fence-toggled.png`,
git-ignored) — eyeball those for anything the assertions don't cover. Any failed assertion prints a
named `❌ <name>: <msg>` and the command **exits non-zero**, so a render regression is loud.

It does **not** cover the editing/round-trip half (typing, save, byte-identity, CRLF, caret reveal
toggle) — that still needs the real VS Code host and stays in the HUMAN smoke entry.

## Adding variations (no restart)

Edit `preview.config.mjs` and refresh the browser — the config is re-read on
every request, so CSS tweaks show immediately.

```js
export default {
  doc: "test/markdown/fixtures/nested-lists.md", // repo-root-relative; or `content: "..."`
  theme: "light",                                 // "light" | "dark"
  variations: [
    { label: "baseline", css: "" },
    { label: "wider gap", css: ".cm-content { letter-spacing: 0.02em; }" },
    // { label: "probe", css: "", js: "console.log(getComputedStyle(document.querySelector('.cm-line')).textIndent);" },
  ],
};
```

- One variation → `/` redirects to the full-viewport render.
- Two or more → `/` shows a responsive **compare grid**, one `<iframe>` per
  variation. Each iframe is an isolated document, so its injected `css` and the
  runtime prose-space measurement never cross-talk with the others.
- Each variation may also carry `js` (a string of JS), run once via
  `requestAnimationFrame` after the document is seeded — handy for
  `getComputedStyle` probes.

## How seeding works

The page stubs the VS Code webview runtime just enough to boot the real bundle:

1. `window.acquireVsCodeApi` is defined (as a function) **before** the module
   bundle runs, else the webview paints its init-error banner.
2. Seeding uses the real protocol handshake, not a blind timer: the webview
   posts `{ protocol: 1, type: "ready" }` through the shim when it mounts (after
   its `window` message listener is wired). The shim detects that and only then
   `window.postMessage`es the `document` seed
   (`{ protocol: 1, type: "document", content, docVersion: 1, themeKind, canWrite: true }`).

## The `--vscode-*` stubbing caveat

Real webviews inherit a large set of `--vscode-*` CSS custom properties. In a
plain browser they don't exist, so `preview.template.html` stubs every one the
bundle references (light values on `:root`, dark overrides on `html.dark-theme`).
**`--vscode-font-family` / `--vscode-font-size` must be realistic**: the
nested-list indent is measured at runtime from the proportional font's space
advance (`prose-space-metric.ts`), so a wrong font misrepresents indent geometry.
If VS Code's real values drift or the bundle references a new `--vscode-*` var,
update the stub block in `preview.template.html`.
