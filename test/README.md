# Tests

Vitest runs in a Node environment; no jsdom (the Markdown bridge is pure).

## Run

- `pnpm test` — single run, used in CI.
- `pnpm test:watch` — re-runs on change.

## Adding a fixture

1. Drop `test/markdown/fixtures/<case>.md`; the filename describes the case.
2. Start with one `<!-- case: ... -->` header line; `load-fixtures.ts` strips it
   before exposing `source`, so the header is reviewer metadata only.
3. Keep each fixture under 16 KiB and end it with a newline.
4. `loadFixtures()` and `fixtures.test.ts` pick up new files automatically.

Vitest reports per-fixture pass/fail by filename — a failing row points at the
offending `.md`.

## Cross-suite fixtures (`test/fixtures/`)

Distinct from the `.md` corpus above: `test/fixtures/` holds TypeScript modules
that state ONE contract two suites must agree on, so a change on either side
reds the other. Reach for one only when the same rule is implemented twice on
purpose — typically across the host ⇄ webview process boundary, when a shared
source module was deliberately rejected. Prefer a shared module when one is
viable: the boundary does not forbid it, and `src/markdown/url-allowlist.ts`
(`isAllowedUrl`) and `src/shared/protocol.ts` (`MAX_HREF_LENGTH`) are already
imported by both processes. A fixture is for what stays duplicated on purpose —
the cascade that composes those predicates, not the predicates themselves.

Every module here MUST be in some tsconfig `include` (see the "permanently
vacuous" hazard in `.claude/CLAUDE.md`), otherwise its type-level content is
never checked. `test/webview/tsconfig.json` includes `../fixtures/**/*.ts`
today; note that program is typed `["vscode-webview", "node"]`, so a future
host-only fixture importing `vscode` types will not resolve under it and
`test/fixtures/` will need its own tsconfig.

- [open-link-destinations.ts](fixtures/open-link-destinations.ts) — the
  `open-link` structural cascade, consumed by both
  `test/webview/cm-link-target.test.ts` and
  `test/extension/links/handle-open-link.test.ts`.

Keep each row's expectation a single value both suites assert against; anything
only one side can know (a resolved path, a rejection arm) stays in that suite.
