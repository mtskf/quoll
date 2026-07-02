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
