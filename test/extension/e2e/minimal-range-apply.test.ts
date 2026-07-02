import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, VIEW_TYPE } from "./harness";

describe("minimal-range-apply", function () {
  this.timeout(20000);
  let tempFile: string | null = null;

  before(async () => {
    await getHarness();
  });
  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("emits a minimal WorkspaceEdit range, not a whole-document replace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-min-"));
    tempFile = path.join(dir, "min.md");
    const base = "# Title\n\nhello world\n";
    await fs.writeFile(tempFile, base);
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    // Capture the WorkspaceEdit the host builds by RESOLVING the promise WITH
    // it (so `captured` is a non-null `WorkspaceEdit` const — avoids the
    // closure-assigned `let ... | null` narrowing pitfall). The override
    // returns true so settlement proceeds; we never mutate — only inspect.
    let resolveEdit!: (edit: vscode.WorkspaceEdit) => void;
    const gotEdit = new Promise<vscode.WorkspaceEdit>((r) => {
      resolveEdit = r;
    });
    harness.applyEditOverride = async (edit: vscode.WorkspaceEdit) => {
      resolveEdit(edit);
      return true;
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    // Insert "brave " before "world" — a single mid-document edit.
    const next = "# Title\n\nhello brave world\n";
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: next,
      baseDocVersion: seed.message.docVersion,
    });

    const captured = await Promise.race([
      gotEdit,
      new Promise<vscode.WorkspaceEdit>((_, reject) =>
        setTimeout(() => reject(new Error("applyEdit override never reached")), 5000)
      ),
    ]);
    const edits = captured.get(uri);
    assert.strictEqual(edits.length, 1, "expected exactly one TextEdit");
    const te = edits[0];
    // Revert-check: a whole-document replace would be a NON-empty range from
    // (0,0) with the full document as newText. The minimal edit is a zero-width
    // insertion of "brave " at the "world" position (line 2, char 6).
    assert.strictEqual(te.newText, "brave ", `newText was: ${JSON.stringify(te.newText)}`);
    assert.ok(te.range.isEmpty, "minimal insertion range must be zero-width");
    assert.strictEqual(te.range.start.line, 2, `start line was: ${te.range.start.line}`);
    assert.strictEqual(te.range.start.character, 6, `start char was: ${te.range.start.character}`);
  });
});
