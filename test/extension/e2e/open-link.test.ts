import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, openFixtureWithQuoll } from "./harness";

describe("open-link", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    harness.openLinkOverride = null;
    await cleanupBetweenTests(harness);
  });

  it("resolves and opens a relative .md link target with the Quoll editor", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("link-source.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const opened: string[] = [];
    harness.openLinkOverride = (uri): Promise<unknown> => {
      opened.push(uri.path);
      return Promise.resolve(undefined);
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-link",
      href: "./link-target.md",
    });

    // handleOpenLink is synchronous through the gate; the override runs inline.
    await Promise.resolve();

    assert.strictEqual(opened.length, 1, "expected the open-link target to be opened once");
    assert.ok(
      opened[0].endsWith("/link-target.md"),
      `expected the resolved target to end with /link-target.md, got ${opened[0]}`
    );
  });

  it("does NOT open a target that escapes the workspace/document dir", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("link-source.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const opened: string[] = [];
    harness.openLinkOverride = (uri): Promise<unknown> => {
      opened.push(uri.path);
      return Promise.resolve(undefined);
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-link",
      href: "../../../../../../etc/passwd.md",
    });

    await Promise.resolve();

    assert.deepStrictEqual(
      opened,
      [],
      "expected the host containment gate to drop an out-of-scope open-link"
    );
  });
});
