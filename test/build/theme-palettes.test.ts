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
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs this
// transpile-only and tsc does not include test/build/ in `pnpm compile`.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bodyThemeAttrs,
  PALETTES,
  THEME_KINDS,
  themeVarsCss,
} from "../../scripts/preview/vscode-theme-palettes.mjs";
import { THEME_KINDS as WIRE_THEME_KINDS } from "../../src/shared/protocol";

const stylesCss = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

const UNKNOWN_KIND = "hc-darkk"; // a plausible typo, not a wild string

describe("vscode-theme-palettes — themeKind vocabulary", () => {
  it("covers exactly the wire ThemeKind vocabulary (no unmapped kind, no extra table)", () => {
    // Imported from protocol.ts rather than restated: a hand-copied list here
    // would be the fifth copy of this vocabulary and could drift with the rest.
    expect([...THEME_KINDS].sort()).toEqual([...WIRE_THEME_KINDS].sort());
  });

  it("derives THEME_KINDS from the tables themselves", () => {
    expect(THEME_KINDS).toEqual(Object.keys(PALETTES));
  });

  it("renders a DISTINCT :root block per kind (no kind proxies another)", () => {
    const emitted = THEME_KINDS.map(themeVarsCss);
    expect(new Set(emitted).size).toBe(THEME_KINDS.length);
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
        // the wrong selector.
        expect(stylesCss).toMatch(new RegExp(`body\\.${cls}(?![\\w-])`));
      }
      expect(stylesCss).toContain(`body[data-vscode-theme-kind="${dataThemeKind}"]`);
    });
  }
});
