// Non-vacuity pins for scripts/preview/vscode-theme-palettes.mjs.
//
// The preview harness feeds the a11y probe, and one of that probe's checks
// (`frontmatter-text-contrast`) is fatal. So a themeKind that quietly renders
// with the WRONG palette does not just produce a bad report — it produces a
// green AA number measured against colours the user never sees. That was
// A11Y-08b: hc-light/hc-dark reused the light stub and nothing said so.
//
// The probe itself only runs locally (`pnpm a11y:probe`, real Chromium, not in
// CI), so these tests are the CI-side guard on the module's contract:
//   1. its themeKind vocabulary IS the wire vocabulary (no fifth kind, no gap),
//   2. an unmapped kind FAILS LOUD instead of silently substituting light,
//   3. the <body> compat strings it emits still exist as selectors in styles.css.
// They pin the contract, not the colour values — provenance/drift of individual
// tokens is documented in the module and is deliberately not asserted here.
//
// No file-level @ts-nocheck: the only untyped thing here is the plain .mjs import
// (suppressed on that line alone), and blanketing the file would also un-check the
// typed `src/shared/protocol` import below — the one cross-boundary contract these
// tests assert on, and the one whose rename should not wait for vitest to surface.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Namespace import so the module specifier — where TS7016 is reported — stays on
// the same line as the directive. A named import wide enough to hold all four
// bindings wraps past Biome's line width, which pushes the specifier out from
// under the directive and leaves the suppression unused (and the error live).
// @ts-expect-error — plain .mjs with no bundled types; vitest transpiles it.
import * as themePalettes from "../../scripts/preview/vscode-theme-palettes.mjs";
import { THEME_KINDS as WIRE_THEME_KINDS } from "../../src/shared/protocol";

const { bodyThemeAttrs, PALETTES, THEME_KINDS, themeVarsCss } = themePalettes;

const stylesCss = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");
// Live rules only — see the comment-strip rationale at the selector assertions below.
const liveCss = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");

const UNKNOWN_KIND = "hc-darkk"; // a plausible typo, not a wild string

describe("vscode-theme-palettes — themeKind vocabulary", () => {
  it("covers exactly the wire ThemeKind vocabulary (no unmapped kind, no extra table)", () => {
    // Imported from protocol.ts rather than restated: a hand-copied list here
    // would be the fifth copy of this vocabulary and could drift with the rest.
    expect([...THEME_KINDS].sort()).toEqual([...WIRE_THEME_KINDS].sort());
  });

  it("every advertised kind has its own populated table (no kind advertised without a palette)", () => {
    // NOT `toEqual(Object.keys(PALETTES))`: THEME_KINDS *is* that expression, so
    // such an assertion restates the implementation and cannot go red. The property
    // that matters is that each advertised kind resolves to a real table.
    for (const kind of THEME_KINDS) {
      expect(Object.keys(PALETTES[kind]).length).toBeGreaterThan(20);
    }
  });

  it("renders a DISTINCT :root block per kind (no kind proxies another)", () => {
    const emitted = THEME_KINDS.map(themeVarsCss);
    expect(new Set(emitted).size).toBe(THEME_KINDS.length);
  });

  it("no dark-side kind proxies the light palette on the tokens the fatal gate reads", () => {
    // Block-level distinctness above is satisfied by any ONE differing token, so a
    // palette that is 95% light values still passes — exactly the `{...LIGHT}` spread
    // hazard the module warns about. The frontmatter colour the a11y gate measures is
    // color-mix(descriptionForeground 90%, editor-foreground) composited over
    // editor-background, so a spread would collapse precisely these three.
    // Asserted as a DIRECTION, not blanket distinctness: hc-light legitimately shares
    // light's white canvas, so "all four distinct" would be a false invariant.
    for (const token of ["descriptionForeground", "editor-foreground", "editor-background"]) {
      for (const kind of ["dark", "hc-dark"]) {
        expect(PALETTES[kind][token]).not.toBe(PALETTES.light[token]);
      }
    }
  });
});

describe("vscode-theme-palettes — unknown kinds fail loud", () => {
  it("themeVarsCss throws instead of returning the light palette", () => {
    // The regression this guards is specifically "silently equals light": with a
    // `?? LIGHT` fallback this call returns themeVarsCss("light") and passes as
    // if measured. Nothing downstream can tell the difference, so the throw is
    // the signal.
    expect(() => themeVarsCss(UNKNOWN_KIND)).toThrow(/no palette for themeKind/);
  });

  it("bodyThemeAttrs throws instead of stamping the light class", () => {
    expect(() => bodyThemeAttrs(UNKNOWN_KIND)).toThrow(/no <body> stamp for themeKind/);
  });

  it("light is an explicitly mapped kind, not the fallback arm", () => {
    expect(themeVarsCss("light")).toContain("--vscode-editor-background");
    expect(bodyThemeAttrs("light")).toEqual({
      className: "vscode-light",
      dataThemeKind: "vscode-light",
    });
  });

  it("every known kind renders without throwing", () => {
    for (const kind of THEME_KINDS) {
      expect(() => themeVarsCss(kind)).not.toThrow();
      expect(() => bodyThemeAttrs(kind)).not.toThrow();
    }
  });
});

describe("vscode-theme-palettes — registry-null tokens stay omitted", () => {
  it("contrastBorder is absent under light/dark and present under both HC kinds", () => {
    // The module's stated rule: a token whose registry default is null must be
    // OMITTED, so the stylesheet's own var(--x, fallback) is what renders. A
    // `transparent` placeholder would short-circuit that chain invisibly.
    expect(PALETTES.light).not.toHaveProperty("contrastBorder");
    expect(PALETTES.dark).not.toHaveProperty("contrastBorder");
    expect(PALETTES["hc-dark"]).toHaveProperty("contrastBorder");
    expect(PALETTES["hc-light"]).toHaveProperty("contrastBorder");
    expect(themeVarsCss("light")).not.toContain("--vscode-contrastBorder");
    expect(themeVarsCss("hc-dark")).toContain("--vscode-contrastBorder");
  });
});

describe("vscode-theme-palettes — <body> compat stamps match the stylesheet", () => {
  // bodyThemeAttrs exists ONLY to exercise Quoll's body-level HC compatibility
  // selectors. Nothing else pins the two sides together, so a rename on either
  // side would leave the harness stamping strings the stylesheet ignores — and
  // the HC path would stop being exercised without any test going red.
  for (const kind of ["hc-dark", "hc-light"]) {
    it(`${kind}: emitted classes + data-vscode-theme-kind exist as selectors in styles.css`, () => {
      const { className, dataThemeKind } = bodyThemeAttrs(kind);
      for (const cls of className.split(/\s+/).filter(Boolean)) {
        // Boundary-guarded: `vscode-high-contrast` is a prefix of
        // `vscode-high-contrast-light`, so a bare substring test would pass on
        // the wrong selector. Comments are stripped FIRST because styles.css
        // documents these selectors in prose (`body.vscode-high-contrast*`) and a
        // whole-file match is satisfied by that literal alone — `*` is not [\w-], so
        // the boundary guard does not stop it, and deleting the live rule left both
        // HC cases green. Same precedent as styles-contract.test.ts.
        expect(liveCss).toMatch(new RegExp(`body\\.${cls}(?![\\w-])`));
      }
      expect(liveCss).toContain(`body[data-vscode-theme-kind="${dataThemeKind}"]`);
    });
  }
});
