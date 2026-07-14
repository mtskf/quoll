import { describe, expect, it } from "vitest";
import { ColorThemeKind } from "vscode";
import { themeKindFromColorTheme } from "../../../src/extension/session/theme-kind.js";

// Pins the host-side ColorThemeKind → wire ThemeKind mapping — the robustness
// fix's core contract. The two HC kinds must map to DISTINCT hc-* values, both
// separate from "light": the whole point is that HC Black no longer falls back
// to the light palette. This lives in the unit gate (the E2E round-trip does
// not), so a regression like HighContrastLight → "light" reds here.
describe("themeKindFromColorTheme", () => {
  it("maps Light → light", () => {
    expect(themeKindFromColorTheme(ColorThemeKind.Light)).toBe("light");
  });

  it("maps Dark → dark", () => {
    expect(themeKindFromColorTheme(ColorThemeKind.Dark)).toBe("dark");
  });

  it("maps HighContrast (HC Black) → hc-dark, distinct from light", () => {
    expect(themeKindFromColorTheme(ColorThemeKind.HighContrast)).toBe("hc-dark");
  });

  it("maps HighContrastLight → hc-light, distinct from light", () => {
    expect(themeKindFromColorTheme(ColorThemeKind.HighContrastLight)).toBe("hc-light");
  });
});
