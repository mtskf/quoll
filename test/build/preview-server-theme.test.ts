// Non-vacuity pins for scripts/preview/serve.mjs — theme handling only.
//
// Companion to theme-palettes.test.ts, which pins the palette MODULE. This file
// pins the SERVER's use of it, because the two have different failure modes and
// only the palette side was covered:
//
//   • A SUPPLIED but unmapped theme must fail visibly. serve.mjs used to clamp it
//     to "light", which is the A11Y-08b bug in its most dangerous form: the a11y
//     probe's one fatal gate (`frontmatter-text-contrast`) would then measure the
//     LIGHT palette, report a green AA number, and label it `hc-dark`. Nothing
//     downstream can tell a clamped run from a real one — the 500 is the signal.
//   • An ABSENT theme must still default quietly to light. That is not sloppiness
//     to be "simplified" away later: a config need not name a theme, and the
//     preview seeds the real webview via a hand-rolled `document` message whose
//     themeKind must be one the shell's boundary validator accepts — an unknown
//     value there would drop the seed WHOLE and render an empty editor.
//
// Driven through a real listener on an ephemeral port rather than by calling
// normaliseConfig directly, because the property that matters is what a client
// SEES (status + markup), and the clamp regression is invisible at the config
// level — a clamped config is a perfectly valid config.
//
// Fast by construction: `override` short-circuits loadConfig's file read, and the
// /instance route only fills the template. No esbuild bundle is built on this path.
//
// The .mjs import below is untyped, so it carries a line-scoped
// `@ts-expect-error`; everything this file itself authors stays checked by
// `test/build/tsconfig.json` under `pnpm compile`.
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs with no bundled types; vitest transpiles it.
import { createPreviewServer } from "../../scripts/preview/serve.mjs";

// The <body> stamps a real VS Code webview host applies, restated here as
// literals ON PURPOSE: importing bodyThemeAttrs would make this assertion
// `f(x) === f(x)` and it could never go red. theme-palettes.test.ts pins these
// same strings against styles.css from the other side.
const EXPECTED_BODY = {
  light: { className: "vscode-light", dataThemeKind: "vscode-light" },
  dark: { className: "vscode-dark", dataThemeKind: "vscode-dark" },
  "hc-dark": { className: "vscode-high-contrast", dataThemeKind: "vscode-high-contrast" },
  "hc-light": {
    className: "vscode-high-contrast-light vscode-high-contrast",
    dataThemeKind: "vscode-high-contrast-light",
  },
} as const;

let open: Server | null = null;

// Every test closes its listener here rather than inline: a leaked listener keeps
// the vitest worker's event loop alive and hangs the suite instead of failing it.
afterEach(async () => {
  const server = open;
  open = null;
  if (server) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/** Boot the preview server on an ephemeral port and fetch one rendered instance. */
async function fetchInstance(override: Record<string, unknown>) {
  const server = createPreviewServer({ override });
  open = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no ephemeral port");
  }
  const res = await fetch(`http://127.0.0.1:${address.port}/instance?v=0`);
  return { status: res.status, body: await res.text() };
}

describe("preview server — a supplied but unmapped theme fails visibly", () => {
  it("returns 500 naming the unknown theme, and renders NO light markup", async () => {
    // "drak" is a plausible typo in preview.config.mjs / a probe invocation, which
    // is exactly how this reaches a user — not as a wild string.
    const { status, body } = await fetchInstance({ theme: "drak", content: "# hi\n" });

    expect(status).toBe(500);
    expect(body).toContain('unknown theme "drak"');
    // The load-bearing half. A 500 with light markup in it would still be a
    // regression if the status ever softened, and "renders light silently" is the
    // precise failure being guarded — so assert the light stamp is ABSENT, not
    // merely that an error was mentioned somewhere.
    expect(body).not.toContain("vscode-light");
  });
});

describe("preview server — an absent theme still defaults to light", () => {
  it("renders 200 with the light stamp (seed-drop protection, deliberately kept)", async () => {
    const { status, body } = await fetchInstance({ content: "# hi\n" });

    expect(status).toBe(200);
    expect(body).toContain('<body class="vscode-light"');
  });
});

describe("preview server — every real themeKind renders under its own label", () => {
  for (const [kind, { className, dataThemeKind }] of Object.entries(EXPECTED_BODY)) {
    it(`${kind}: 200, stamps its own <body>, and seeds the wire kind unchanged`, async () => {
      const { status, body } = await fetchInstance({ theme: kind, content: "# hi\n" });

      expect(status).toBe(200);
      // Matched as the whole attribute, not a substring: `vscode-high-contrast` is
      // a prefix of `vscode-high-contrast-light`, so a bare `toContain` would pass
      // on the wrong stamp for two of the four kinds.
      expect(body).toContain(
        `<body class="${className}" data-vscode-theme-kind="${dataThemeKind}"`
      );
      // The seed carries the WIRE value (`hc-light`), not the DOM stamp — this is
      // the label the a11y probe's report is filed under, so it must equal what
      // was asked for rather than anything coerced along the way.
      expect(body).toContain(`var THEME_KIND = ${JSON.stringify(kind)};`);
    });
  }
});
