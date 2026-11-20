import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigurationTarget, workspace } from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

function readExternalOpenLog(): string[] {
  const logPath = process.env.QUOLL_E2E_EXTERNAL_OPEN_LOG;
  assert.ok(logPath, "missing QUOLL_E2E_EXTERNAL_OPEN_LOG");
  try {
    return readFileSync(logPath, "utf8").split("\n").slice(0, -1);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function markExternalOpenLog(): number {
  return readExternalOpenLog().length;
}

async function waitForExternalOpen(
  mark: number,
  expected: string,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed = readExternalOpenLog().slice(mark);
  while (!observed.includes(expected)) {
    if (Date.now() >= deadline) {
      assert.fail(
        `expected external open ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`
      );
    }
    await tick();
    observed = readExternalOpenLog().slice(mark);
  }
}

/**
 * Exercises the panel's open-external wiring through VS Code's real opener.
 * The configured browser and PATH shims record the final URL argument.
 * Loopback hosts pass the trusted-domain check without a dialog.
 */
const describeExternalOpen = process.platform === "win32" ? describe.skip : describe;

describeExternalOpen("open-external", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
    await workspace
      .getConfiguration("workbench")
      .update("externalBrowser", "quoll-e2e-browser", ConfigurationTarget.Global);
  });

  after(async () => {
    await workspace
      .getConfiguration("workbench")
      .update("externalBrowser", undefined, ConfigurationTarget.Global);
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("hands off an allowlisted URL", async () => {
    const mark = markExternalOpenLog();
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "http://localhost:9",
    });

    await waitForExternalOpen(mark, "http://localhost:9");
  });

  it("hands the OS the original string byte-for-byte", async () => {
    const mark = markExternalOpenLog();
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const raw = "https://localhost:9/p/foo%2Fbar%20baz/日本語?q=a+b%20c&r=%26#x%20y";
    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href: raw });

    await waitForExternalOpen(mark, raw);
  });

  it("still hands off the next URL after an empty authority", async () => {
    const mark = markExternalOpenLog();
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const sentinel = "http://127.0.0.1:9/sentinel";
    const panel = harness.activePanel;
    assert.ok(panel);
    // The rejected https:// open raises an expected error toast.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href: "https://" });
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href: sentinel });

    await waitForExternalOpen(mark, sentinel);
  });
});
