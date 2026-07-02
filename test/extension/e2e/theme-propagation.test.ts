import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  isThemeEvent,
  openFixtureWithQuoll,
} from "./harness";

const DARK_THEME = "Default Dark+";
const LIGHT_THEME = "Default Light+";

// Pins host→webview theme propagation: onDidChangeActiveColorTheme posts a
// `theme` message carrying the new dark/light state. Driven by flipping
// workbench.colorTheme; the order is chosen so the FIRST switch always
// changes the theme kind (guaranteeing an event) regardless of the
// instance's starting theme.
describe("theme-propagation", function () {
  this.timeout(25000);

  let originalTheme: unknown;

  before(async () => {
    await getHarness();
    originalTheme = vscode.workspace.getConfiguration("workbench").get("colorTheme");
  });

  afterEach(async () => {
    const harness = await getHarness();
    await vscode.workspace
      .getConfiguration("workbench")
      .update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
    await cleanupBetweenTests(harness);
  });

  it("posts a theme message when the active color theme changes", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);
    harness.clearEvents();

    const startedDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    // First switch flips the kind (guaranteed event); second switches back.
    const firstTheme = startedDark ? LIGHT_THEME : DARK_THEME;
    const firstDark = !startedDark;
    const secondTheme = startedDark ? DARK_THEME : LIGHT_THEME;
    const secondDark = startedDark;

    const cfg = () => vscode.workspace.getConfiguration("workbench");

    await cfg().update("colorTheme", firstTheme, vscode.ConfigurationTarget.Global);
    const first = await harness.waitForEvent(
      (e) => isThemeEvent(e) && e.message.isDarkTheme === firstDark,
      8000
    );
    assert.strictEqual(
      first.message.isDarkTheme,
      firstDark,
      `theme message must report isDarkTheme=${firstDark} for ${firstTheme}`
    );

    await cfg().update("colorTheme", secondTheme, vscode.ConfigurationTarget.Global);
    const second = await harness.waitForEvent(
      (e) => isThemeEvent(e) && e.message.isDarkTheme === secondDark,
      8000
    );
    assert.strictEqual(
      second.message.isDarkTheme,
      secondDark,
      `theme message must report isDarkTheme=${secondDark} for ${secondTheme}`
    );
  });
});
