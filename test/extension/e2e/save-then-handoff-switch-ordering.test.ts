import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  isDocumentEvent,
  openTempQuoll,
  pollUntil,
  tick,
  VIEW_TYPE,
} from "./harness";

const B = "# Latest\n\n[bad](javascript:alert(1))\n";
const arms = [
  { type: "context-handoff", command: "claude-code.insertAtMentioned" },
  { type: "codex-context-handoff", command: "chatgpt.addFileToThread" },
  { type: "switch-to-text", command: null },
] as const;

function hasQuoll(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .some(
      (t) =>
        t.input instanceof vscode.TabInputCustom &&
        t.input.viewType === VIEW_TYPE &&
        t.input.uri.toString() === uri.toString()
    );
}

function hasText(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .some(
      (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()
    );
}

describe("save-then-handoff-switch-ordering", function () {
  this.timeout(30000);
  afterEach(async () => cleanupBetweenTests(await getHarness()));

  for (const [index, content] of [
    "[x](javascript:alert(1))",
    "![x](data:image/svg+xml,test)",
    "[x](file:///tmp/example.md)",
    "[x](//example.com/path)",
    "[x](javascript&#58;alert(1))",
    "[x][id]\n\n[id]: javascript:alert(1)",
    "![x][id]\n\n[id]: data:image/png,x",
    "[id][]\n\n[id]: file:///tmp/x",
    "[id]\n\n[id]: //example.com/x",
    "| h |\n| --- |\n| [x](javascript:1) |",
    "<javascript:alert(1)>",
    "<xmpp:user@example.com>",
    "---\ntitle: unfinished",
    "---\ntitle: x\u2028---\n---\nbody\n",
    "---\ntitle: x\r---\n---\nbody\n",
    "[unused]: javascript:1\n",
    "[x][id]\n\n[id]: https://example.com\n[id]: javascript:1\n",
  ].entries()) {
    it(`stores formerly rejected Markdown ${index} through direct Edit and explicit save`, async () => {
      const harness = await getHarness();
      const { panel, file, uri } = await openTempQuoll(
        harness,
        "seed\n",
        `admission-${index}`,
        null
      );
      const seed = await harness.waitForEvent(isDocumentEvent, 8000);
      harness.clearEvents();
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        editId: 1,
        baseDocVersion: seed.message.docVersion,
        content,
      });
      const ack = await harness.waitForEvent(
        (e) => isDocumentEvent(e) && e.message.settledEditId === 1,
        8000
      );
      // TextDocument normalizes lone CR to the document EOL; admission receives the original input.
      const expected = content.replace(/\r\n|\r/g, "\n");
      assert.strictEqual(ack.message.content, expected);
      assert.strictEqual(panel.document.getText(), expected);
      assert.ok(panel.document.isDirty);
      assert.ok(await panel.document.save());
      assert.strictEqual(await fs.readFile(file, "utf8"), expected);
      harness.clearEvents();
      panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
      const reload = await harness.waitForEvent(isDocumentEvent, 8000);
      assert.strictEqual(reload.message.content, expected);
      assert.strictEqual(
        reload.message.docVersion,
        (await vscode.workspace.openTextDocument(uri)).version
      );
    });
  }

  for (const arm of arms) {
    for (const refuseB of [false, true]) {
      it(`${arm.type} waits through A and stashed B (${refuseB ? "refused then retry" : "saved"})`, async () => {
        const harness = await getHarness();
        const { panel, file, uri } = await openTempQuoll(
          harness,
          "seed\n",
          `${arm.type}-${refuseB}`,
          null
        );
        const seed = await harness.waitForEvent(isDocumentEvent, 8000);
        const gateA = deferred<boolean>();
        const gateB = deferred<boolean>();
        let calls = 0;
        const observed: string[] = [];
        let consumerCalls = 0;
        const sub = arm.command
          ? vscode.commands.registerCommand(arm.command, async () => {
              consumerCalls++;
              observed.push(await fs.readFile(file, "utf8"));
            })
          : undefined;
        harness.applyEditOverride = (edit) => {
          calls++;
          if (calls === 1) {
            return vscode.workspace.applyEdit(edit).then((ok) => gateA.promise.then(() => ok));
          }
          if (calls === 2) {
            return gateB.promise.then((ok) => (ok ? vscode.workspace.applyEdit(edit) : false));
          }
          return vscode.workspace.applyEdit(edit);
        };
        const request = () => {
          if (arm.type === "context-handoff") {
            panel.simulateInbound({
              protocol: PROTOCOL_VERSION,
              type: arm.type,
              hasSelection: false,
              startLine: 1,
              endLine: 1,
            });
          } else {
            panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: arm.type });
          }
        };
        try {
          panel.simulateInbound({
            protocol: PROTOCOL_VERSION,
            type: "edit",
            editId: 1,
            baseDocVersion: seed.message.docVersion,
            content: "first",
          });
          await pollUntil(() => panel.document.getText() === "first", "A applied", 5000);
          panel.simulateInbound({
            protocol: PROTOCOL_VERSION,
            type: "edit",
            editId: 2,
            baseDocVersion: seed.message.docVersion,
            content: B,
          });
          request();
          await tick(200);
          assert.deepStrictEqual(observed, []);
          assert.strictEqual(consumerCalls, 0);
          assert.ok(!hasText(uri));
          assert.ok(hasQuoll(uri));
          assert.strictEqual(await fs.readFile(file, "utf8"), "seed\n");
          gateA.resolve(true);
          await pollUntil(() => calls === 2, "B apply entered", 5000);
          await tick(200);
          assert.deepStrictEqual(observed, []);
          assert.strictEqual(consumerCalls, 0);
          assert.ok(!hasText(uri));
          assert.ok(hasQuoll(uri));
          assert.strictEqual(await fs.readFile(file, "utf8"), "seed\n");
          gateB.resolve(!refuseB);
          await harness.waitForEvent(
            (e) => isDocumentEvent(e) && e.message.settledEditId === 2,
            8000
          );
          if (refuseB) {
            await tick(200);
            assert.deepStrictEqual(observed, []);
            assert.strictEqual(consumerCalls, 0);
            assert.ok(!hasText(uri));
            assert.ok(hasQuoll(uri));
            const version = panel.document.version;
            panel.simulateInbound({
              protocol: PROTOCOL_VERSION,
              type: "edit",
              editId: 3,
              baseDocVersion: version,
              content: B,
            });
            await harness.waitForEvent(
              (e) => isDocumentEvent(e) && e.message.settledEditId === 3,
              8000
            );
            request();
          }
          await pollUntil(
            () => (arm.command ? observed.length === 1 : !hasQuoll(uri)),
            "consumer completed",
            8000
          );
          assert.strictEqual(await fs.readFile(file, "utf8"), B);
          if (arm.command) {
            assert.strictEqual(consumerCalls, 1);
            assert.deepStrictEqual(observed, [B]);
          } else {
            assert.ok(hasText(uri));
          }
        } finally {
          gateA.resolve(true);
          gateB.resolve(false);
          sub?.dispose();
        }
      });
    }
  }

  for (const command of [false, true]) {
    it(`accepted edit during async text open drains after close (${command ? "command" : "webview"})`, async () => {
      const harness = await getHarness();
      const { panel, uri } = await openTempQuoll(harness, "seed", `async-open-${command}`, null);
      const seed = await harness.waitForEvent(isDocumentEvent, 8000);
      await vscode.window.showTextDocument(panel.document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      });
      const gate = deferred<boolean>();
      harness.applyEditOverride = (edit) =>
        gate.promise.then(() => vscode.workspace.applyEdit(edit));
      try {
        harness.clearEvents();
        const swap = command
          ? vscode.commands.executeCommand("quoll.reopenInTextEditor")
          : undefined;
        if (command) {
          // The command routes through the webview gate; let the real webview's
          // switch-to-text land (lock-free) before the later Edit arrives.
          await harness.waitForInbound(
            (event) => (event.raw as { type?: string } | null)?.type === "switch-to-text",
            8000
          );
        } else {
          panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });
        }
        panel.simulateInbound({
          protocol: PROTOCOL_VERSION,
          type: "edit",
          editId: 1,
          baseDocVersion: seed.message.docVersion,
          content: B,
        });
        // The async open began lock-free. Its close can finish while this later
        // accepted Edit is in flight; the text tab keeps the document alive.
        await pollUntil(() => !hasQuoll(uri), "Quoll closed during the gated apply", 8000);
        assert.ok(hasText(uri));
        gate.resolve(true);
        await swap;
        await pollUntil(
          () => panel.document.getText() === B,
          "accepted bytes survived async close",
          8000
        );
      } finally {
        gate.resolve(true);
      }
      assert.strictEqual(panel.document.uri.toString(), uri.toString());
    });
  }
});
