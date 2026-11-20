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

async function waitForExternalOpen(mark: number, expected: string): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const observed = readExternalOpenLog().slice(mark);
    if (observed.includes(expected)) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(
        `expected external open ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`
      );
    }
    await tick();
  }
}

async function openSamplePanel() {
  const harness = await getHarness();
  await openFixtureWithQuoll("sample.md");
  await harness.waitForEvent(isDocumentEvent, 8000);

  const panel = harness.activePanel;
  assert.ok(panel, "no active panel after openFixtureWithQuoll");
  return panel;
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
    const panel = await openSamplePanel();
    const href = "http://localhost:9";

    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href });

    await waitForExternalOpen(mark, href);
  });

  it("hands the OS the original string byte-for-byte", async () => {
    const mark = markExternalOpenLog();
    const panel = await openSamplePanel();
    const href = "https://localhost:9/p/foo%2Fbar%20baz/日本語?q=a+b%20c&r=%26#x%20y";

    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href });

    await waitForExternalOpen(mark, href);
  });

  it("still hands off the next URL after an empty authority", async () => {
    const mark = markExternalOpenLog();
    const harness = await getHarness();
    const panel = await openSamplePanel();
    const sentinel = "http://127.0.0.1:9/sentinel";

    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href: "https://" });
    await harness.waitForError((msg) => msg.startsWith("Quoll: couldn't open the link."));
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "open-external", href: sentinel });

    await waitForExternalOpen(mark, sentinel);
  });
});
