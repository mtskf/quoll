import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

describe("open-code-reference", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    harness.openCodeReferenceOverride = null;
    harness.codeReferenceExistsOverride = null;
    await cleanupBetweenTests(harness);
  });

  async function seed() {
    const harness = await getHarness();
    await openFixtureWithQuoll("code-ref-source.md");
    await harness.waitForEvent(isDocumentEvent, 8000);
    return harness;
  }

  it("opens an existing workspace file at the parsed line/col", async () => {
    const harness = await seed();
    const opened: Array<{ path: string; line?: number; col?: number }> = [];
    harness.codeReferenceExistsOverride = () => Promise.resolve(true);
    harness.openCodeReferenceOverride = (uri, line, col) => {
      opened.push({ path: uri.path, line, col });
      return Promise.resolve(undefined);
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-code-reference",
      path: "code-ref-target.ts",
      line: 2,
    });

    await tick(50);

    assert.strictEqual(opened.length, 1, "expected the code reference to be opened once");
    assert.ok(
      opened[0].path.endsWith("/code-ref-target.ts"),
      `expected the resolved target to end with /code-ref-target.ts, got ${opened[0].path}`
    );
    assert.strictEqual(opened[0].line, 2);
  });

  it("never opens a workspace-escape path", async () => {
    const harness = await seed();
    let opened = 0;
    harness.codeReferenceExistsOverride = () => Promise.resolve(true);
    harness.openCodeReferenceOverride = () => {
      opened += 1;
      return Promise.resolve(undefined);
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-code-reference",
      path: "../../../../etc/passwd",
    });

    await tick(50);

    assert.strictEqual(opened, 0, "expected the host containment gate to drop an escape path");
  });

  it("never opens a missing file", async () => {
    const harness = await seed();
    let opened = 0;
    harness.codeReferenceExistsOverride = () => Promise.resolve(false);
    harness.openCodeReferenceOverride = () => {
      opened += 1;
      return Promise.resolve(undefined);
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-code-reference",
      path: "code-ref-target.ts",
      line: 2,
    });

    await tick(50);

    assert.strictEqual(opened, 0, "expected a missing target to never be opened");
  });
});
