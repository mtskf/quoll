import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, tick, VIEW_TYPE } from "./harness";
import type { PanelControlsShape, StatusBarItemProbeShape, TestHarnessShape } from "./types";

// Pins the panel-side status-bar wiring PR #158 left untested: the item shows on
// the panel's ACTIVE edge, hides on the INACTIVE edge, is independent per panel,
// and disposes with the panel. window.createStatusBarItem is invisible to the
// E2E harness (the real item exposes nothing the test host can read back), so
// under the harness the panel builds recording FakeStatusBarItems and hands the
// trio through PanelControls.statusBarItems (src/extension/test-harness.ts).
//
// Counting note: raw show/hide COUNTS are NOT asserted `=== 1` per transition.
// VS Code may fire several onDidChangeViewState events for one tab switch, and
// the panel re-shows + refreshes caret on every active event, so the show count
// for a single activation is `>= 1`, not exactly 1. The load-bearing,
// non-flaky signals are instead: (a) the deterministic `visible` end-state,
// (b) the WRONG edge NOT firing — the counter that must not move stays equal to
// its pre-transition snapshot, which is what proves "shows on active / hides on
// inactive" AND per-panel independence — and (c) dispose firing exactly once
// (teardown runs once, so `=== 1` there is deterministic).

// Poll a predicate until true or the deadline passes. Used to await the
// onDidChangeViewState-driven `visible` transitions (async, VS-Code-timed).
async function pollUntil(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await tick(50);
  }
}

// Open a temp .md in Quoll and return the NEWLY-registered panel controls. The
// harness tracks only the most-recently-resolved panel as `activePanel`, so
// poll until it becomes a panel distinct from `previous`. Mirrors the helper in
// two-panel-config-caret.test.ts.
async function openTempQuoll(
  harness: TestHarnessShape,
  content: string,
  slug: string,
  previous: PanelControlsShape | null
): Promise<{ uri: vscode.Uri; file: string; panel: PanelControlsShape }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quoll-sbar-${slug}-`));
  const file = path.join(dir, `${slug}.md`);
  await fs.writeFile(file, content);
  const uri = vscode.Uri.file(file);

  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  const deadline = Date.now() + 8000;
  for (;;) {
    const panel = harness.activePanel;
    if (panel && panel !== previous) {
      return { uri, file, panel };
    }
    if (Date.now() >= deadline) {
      throw new Error(`panel for ${slug} did not register a distinct activePanel`);
    }
    await tick(50);
  }
}

const allVisible = (items: readonly StatusBarItemProbeShape[]): boolean =>
  items.length === 3 && items.every((i) => i.visible);
const allHidden = (items: readonly StatusBarItemProbeShape[]): boolean =>
  items.length === 3 && items.every((i) => !i.visible);

// Snapshot the show/hide counts so a later assertion can prove a counter did
// (or did NOT) move across a transition.
type Counts = { show: number; hide: number };
const snapshot = (items: readonly StatusBarItemProbeShape[]): Counts[] =>
  items.map((i) => ({ show: i.showCount, hide: i.hideCount }));

describe("status-bar-active-edge", function () {
  this.timeout(40000);

  const files: string[] = [];

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    await Promise.all(files.splice(0).map((f) => fs.unlink(f).catch(() => undefined)));
  });

  it("shows on the active edge, hides on the inactive edge, per panel, and disposes on close", async () => {
    const harness = await getHarness();

    // --- Panel A opens active → its status-bar trio shows -------------------
    const a = await openTempQuoll(harness, "a0\na1\na2\n", "doca", null);
    files.push(a.file);
    assert.strictEqual(
      a.panel.statusBarItems.length,
      3,
      "panel A must expose three status-bar items"
    );
    await pollUntil(() => allVisible(a.panel.statusBarItems), "panel A status bar visible");
    for (const item of a.panel.statusBarItems) {
      assert.ok(item.showCount >= 1, "A item shown on the active edge");
      assert.strictEqual(item.hideCount, 0, "A item not hidden while it is the only/active panel");
    }
    // Native right-aligned, descending priority (caret leftmost = highest).
    assert.deepStrictEqual(
      a.panel.statusBarItems.map((i) => i.priority),
      [102, 101, 100],
      "status-bar items keep native caret→eol→language priority order"
    );

    // --- Panel B opens → A goes inactive (hide), B shows -------------------
    const aAfterOpen = snapshot(a.panel.statusBarItems);
    const b = await openTempQuoll(harness, "b0\nb1\nb2\nb3\n", "docb", a.panel);
    files.push(b.file);
    assert.notStrictEqual(a.panel, b.panel, "the two panels must be distinct controls");
    assert.notStrictEqual(
      a.panel.statusBarItems,
      b.panel.statusBarItems,
      "each panel owns a distinct status-bar item array"
    );

    await pollUntil(
      () => allHidden(a.panel.statusBarItems) && allVisible(b.panel.statusBarItems),
      "A hidden + B visible after B opens"
    );
    a.panel.statusBarItems.forEach((item, idx) => {
      assert.ok(item.hideCount >= 1, "A item hidden on its inactive edge");
      assert.strictEqual(
        item.showCount,
        aAfterOpen[idx].show,
        "activating B must NOT re-show A's item (per-panel independence)"
      );
    });
    for (const item of b.panel.statusBarItems) {
      assert.ok(item.showCount >= 1, "B item shown on its active edge");
      assert.strictEqual(item.hideCount, 0, "B item not hidden while it is active");
    }

    // --- Reveal A → A shows again, B hides (per-panel independent) ---------
    const aBeforeReveal = snapshot(a.panel.statusBarItems);
    const bBeforeReveal = snapshot(b.panel.statusBarItems);
    a.panel.webviewPanel.reveal();
    await pollUntil(
      () => allVisible(a.panel.statusBarItems) && allHidden(b.panel.statusBarItems),
      "A visible + B hidden after revealing A"
    );
    a.panel.statusBarItems.forEach((item, idx) => {
      assert.ok(item.showCount > aBeforeReveal[idx].show, "A item re-shown on the active edge");
      assert.strictEqual(
        item.hideCount,
        aBeforeReveal[idx].hide,
        "re-activating A must NOT hide A's own item"
      );
    });
    b.panel.statusBarItems.forEach((item, idx) => {
      assert.ok(item.hideCount > bBeforeReveal[idx].hide, "B item hidden when A is revealed");
      assert.strictEqual(
        item.showCount,
        bBeforeReveal[idx].show,
        "revealing A must NOT re-show B's item (per-panel independence)"
      );
    });

    // --- Close both panels → every item disposes exactly once -------------
    const aItems = a.panel.statusBarItems;
    const bItems = b.panel.statusBarItems;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await pollUntil(
      () => [...aItems, ...bItems].every((i) => i.disposeCount === 1),
      "every status-bar item disposed exactly once on close"
    );
  });
});
