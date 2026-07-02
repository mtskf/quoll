// Unit tests for TestHarness.setActivePanel identity-on-clear contract
// and TestHarness.reset's _activePanel clearing.
//
// These pin two invariants the E2E suite leans on but cannot fail-loud
// on by construction:
//   - late-dispose race: panel A disposes after panel B has registered;
//     A's onDidDispose must not null out the active panel reference
//     because B is the current owner.
//   - per-test panel isolation: reset() leaves no stale panel reference
//     that a new test could observe before its own resolve runs.

import { describe, expect, it } from "vitest";

import { type PanelControls, TestHarness } from "../../src/extension/test-harness";

describe("TestHarness.setActivePanel identity-on-clear", () => {
  it("ignores a late-dispose clear when a newer panel is active", () => {
    const harness = new TestHarness();
    const A = {} as PanelControls;
    const B = {} as PanelControls;
    harness.setActivePanel(A);
    harness.setActivePanel(B);
    harness.setActivePanel(null, A);
    expect(harness.activePanel).toBe(B);
  });

  it("clears when the expected matches the active panel", () => {
    const harness = new TestHarness();
    const A = {} as PanelControls;
    harness.setActivePanel(A);
    harness.setActivePanel(null, A);
    expect(harness.activePanel).toBeNull();
  });

  it("throws when called with null and no expected reference", () => {
    // Pins the cycle-2 contract change: a bare `setActivePanel(null)` is
    // a footgun (the only safe unconditional drop is `reset()`), so this
    // path now fails loud instead of clobbering whatever panel is
    // currently active. The active panel must be untouched after the
    // throw — a half-applied clear would be worse than the original
    // footgun.
    const harness = new TestHarness();
    const A = {} as PanelControls;
    harness.setActivePanel(A);
    expect(() => harness.setActivePanel(null)).toThrow(/requires an `expected` reference/);
    expect(harness.activePanel).toBe(A);
  });
});

describe("TestHarness.reset clears _activePanel", () => {
  it("nulls out the active panel so a new test does not observe the prior one", () => {
    const harness = new TestHarness();
    harness.setActivePanel({} as PanelControls);
    harness.reset();
    expect(harness.activePanel).toBeNull();
  });
});

describe("TestHarness.reset clears every override hook", () => {
  // Pins the accessor-conversion contract: each override is installed
  // through a public setter, read back through its getter (proving the
  // setter/getter round-trips the shared `_overrides` registry), and then
  // dropped to null by a single `reset()` call. If a future override is
  // added but its teardown is forgotten, the registry-wide clear still
  // catches it — and this test catches a reset() that stops clearing the
  // registry. No per-hook nulling exists for one to miss.
  it("nulls all four override hooks through the single registry clear", () => {
    const harness = new TestHarness();
    harness.applyEditOverride = async () => true;
    harness.webviewPostMessageOverride = async () => true;
    harness.openExternalOverride = async () => true;
    harness.buildWebviewHtmlOverride = () => "<html></html>";

    expect(harness.applyEditOverride).not.toBeNull();
    expect(harness.webviewPostMessageOverride).not.toBeNull();
    expect(harness.openExternalOverride).not.toBeNull();
    expect(harness.buildWebviewHtmlOverride).not.toBeNull();

    harness.reset();

    expect(harness.applyEditOverride).toBeNull();
    expect(harness.webviewPostMessageOverride).toBeNull();
    expect(harness.openExternalOverride).toBeNull();
    expect(harness.buildWebviewHtmlOverride).toBeNull();
  });
});

describe("TestHarness.clearEvents leaves override hooks intact", () => {
  // Pins the documented clearEvents()/reset() asymmetry: clearEvents() is
  // the outbound-only subset, so the override registry MUST survive it.
  // Two E2E teardowns (e.g. hidden-webview-resync) drain outbound events
  // mid-test via clearEvents() while still relying on an installed
  // override; if clearEvents() ever started clearing `_overrides`, those
  // tests would break only at the slower E2E layer. This pins the
  // invariant at the unit layer so the regression surfaces immediately.
  it("keeps all four override hooks set after clearEvents()", () => {
    const harness = new TestHarness();
    harness.applyEditOverride = async () => true;
    harness.webviewPostMessageOverride = async () => true;
    harness.openExternalOverride = async () => true;
    harness.buildWebviewHtmlOverride = () => "<html></html>";

    harness.clearEvents();

    expect(harness.applyEditOverride).not.toBeNull();
    expect(harness.webviewPostMessageOverride).not.toBeNull();
    expect(harness.openExternalOverride).not.toBeNull();
    expect(harness.buildWebviewHtmlOverride).not.toBeNull();
  });
});
