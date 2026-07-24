import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

// Plan S5 — experiment: racing positional applyEdit semantics (#7, gates S6).
//
// This is a MEASUREMENT spec, not a feature pin. It CONSTRUCTS the race that
// finding #7 is about — a main-thread edit landing in the gap between the
// host computing an applyEdit's span and the applyEdit actually landing — and
// records, deterministically, which of three behaviours VS Code's
// BulkEditService exhibits:
//   (a) TRANSFORMS  — the intervening edit's offset shift is applied to the
//                     pending positional edit, which lands at the intended
//                     logical location (correct merge);
//   (b) REJECTS     — applyEdit() resolves false, the stale edit does not land;
//   (c) MISPLACES   — the stale edit lands at its FROZEN (now-wrong) offsets,
//                     splicing over the wrong text (silent corruption — the
//                     hazard S6's post-apply verification must contain).
//
// Determinism: the ext-host side of runApplyEdit (snapshot → span → build →
// apply) is synchronous, so the race cannot be "hoped for". We construct it
// via the existing `applyEditOverride` seam, which the host consults at the
// EXACT boundary the plan names — the seam receives the ALREADY-BUILT
// WorkspaceEdit (its Ranges frozen from `document.positionAt(span)` against the
// pre-race snapshot) and stands between span/build and the real
// `workspace.applyEdit`. Inside the override we land a racing edit FIRST
// (awaited to completion — it demonstrably lands before the held apply), then
// release the held (stale-positioned) apply. A "try to be fast" e2e run would
// risk a non-reproduction being misread as "safe".
//
// The verdict is emitted to the run log as `[S5-VERDICT] …` and the assertion
// pins whichever of the three well-formed outcomes actually occurred (the doc
// MUST land in one of them — a fourth, unrecognised state fails the suite).
// The recorded verdict feeds LEARNING.md and gates Slice 6's shape.
//
// ENVIRONMENT SCOPE: this spec runs on the DESKTOP ext host only. Remote
// (ssh/wsl/web) hosts route applyEdit RPCs differently and MUST be measured
// separately — a desktop verdict is never generalised to them (see the S5
// LEARNING.md entry + the remote follow-up TODO).

interface RaceOutcome {
  staleEditRanges: string;
  racingApplied: boolean;
  versionAfterRacing: number;
  staleApplied: boolean;
  versionAfterStale: number;
  finalContent: string;
}

describe("racing-applyedit-semantics (Plan S5 experiment)", function () {
  this.timeout(30000);
  let tempFile: string | null = null;

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    harness.applyEditOverride = null;
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  async function openTemp(base: string): Promise<vscode.Uri> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-s5-"));
    tempFile = path.join(dir, "race.md");
    await fs.writeFile(tempFile, base);
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    return uri;
  }

  it("records BulkEditService behaviour when a main-thread edit races a pending positional applyEdit", async () => {
    // Base doc: three distinctly-named lines so the outcomes are unambiguous by
    // content alone.
    const base = "line one\nline two\nline three\n";
    // Webview edit: "three" → "THREE" on the LAST line — a single mid-doc span
    // whose frozen offsets sit AFTER the point the racing edit will shift.
    const next = "line one\nline two\nline THREE\n";
    const uri = await openTemp(base);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "expected an active Quoll panel");

    const doc = panel.document;
    assert.strictEqual(doc.getText(), base, "sanity: doc opens at base content");

    // The three canonical outcomes, computed against the SAME racing insert.
    const racePrefix = "INSERTED\n";
    const misplaced = "INSERTED\nline one\nline THREE\nline three\n"; // stale offsets splice line 2
    const transformed = "INSERTED\nline one\nline two\nline THREE\n"; // offset shift honoured
    const rejected = "INSERTED\nline one\nline two\nline three\n"; // stale edit did not land

    let raceOutcome: RaceOutcome | null = null;
    let overrideError: unknown = null;

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    const versionBeforeAny = doc.version;

    harness.applyEditOverride = async (staleEdit: vscode.WorkspaceEdit) => {
      try {
        // Snapshot the FROZEN ranges the host built (positions computed against
        // the pre-race snapshot) so the verdict records the exact span that
        // went stale.
        const staleEdits = staleEdit.get(uri);
        const staleEditRanges = staleEdits
          .map(
            (te) =>
              `[${te.range.start.line},${te.range.start.character}]-[${te.range.end.line},${te.range.end.character}]="${te.newText}"`
          )
          .join(",");

        // 1. Land the racing main-thread edit FIRST — insert a line at (0,0),
        //    shifting every subsequent offset down one line. Awaited to
        //    completion: it is guaranteed to land before the held apply.
        const racingEdit = new vscode.WorkspaceEdit();
        racingEdit.insert(uri, new vscode.Position(0, 0), racePrefix);
        const racingApplied = await vscode.workspace.applyEdit(racingEdit);
        const versionAfterRacing = doc.version;

        // 2. Release the held apply — issue the stale-positioned edit into the
        //    now-shifted document. This is the real `workspace.applyEdit`; the
        //    override only replaces the seam, not the global.
        const staleApplied = await vscode.workspace.applyEdit(staleEdit);
        const versionAfterStale = doc.version;

        raceOutcome = {
          staleEditRanges,
          racingApplied,
          versionAfterRacing,
          staleApplied,
          versionAfterStale,
          finalContent: doc.getText(),
        };
        // Report the settlement to the host as the real apply would have.
        return staleApplied;
      } catch (err) {
        overrideError = err;
        return false;
      } finally {
        resolveDone();
      }
    };

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: next,
      baseDocVersion: seed.message.docVersion,
    });

    await Promise.race([
      done,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("applyEdit override never reached")), 8000)
      ),
    ]);
    // Let the settlement dispatch + any resync drain (does not mutate the doc).
    await tick(100);

    assert.strictEqual(overrideError, null, `override threw: ${String(overrideError)}`);
    assert.ok(raceOutcome, "race outcome was not captured");
    const o: RaceOutcome = raceOutcome;

    assert.strictEqual(o.racingApplied, true, "racing edit must land (precondition of the race)");

    let verdict: "TRANSFORMS" | "REJECTS" | "MISPLACES" | "UNRECOGNISED";
    if (o.finalContent === transformed) {
      verdict = "TRANSFORMS";
    } else if (o.finalContent === rejected && o.staleApplied === false) {
      verdict = "REJECTS";
    } else if (o.finalContent === misplaced) {
      verdict = "MISPLACES";
    } else {
      verdict = "UNRECOGNISED";
    }

    // The verdict line the runner captures → transcribed verbatim into
    // LEARNING.md. Keep the shape stable; it is the deliverable.
    console.log(
      `[S5-VERDICT] desktop racing-applyEdit: verdict=${verdict} ` +
        `staleApplied=${o.staleApplied} racingApplied=${o.racingApplied} ` +
        `versionBeforeAny=${versionBeforeAny} versionAfterRacing=${o.versionAfterRacing} ` +
        `versionAfterStale=${o.versionAfterStale} staleFrozenRanges=${o.staleEditRanges} ` +
        `finalContent=${JSON.stringify(o.finalContent)}`
    );

    assert.notStrictEqual(
      verdict,
      "UNRECOGNISED",
      `applyEdit produced an unrecognised state: ${JSON.stringify(o.finalContent)}`
    );

    // Whichever of the three occurred, the racing edit itself always survives —
    // a stale positional splice can only corrupt the STALE span, never un-land
    // the racing insert (this is the observation that makes "the epoch must fire
    // on the foreign advance" true regardless of the merge verdict).
    assert.ok(
      o.finalContent.startsWith(racePrefix),
      "racing edit's bytes must survive the stale apply"
    );

    // === DESKTOP VERDICT PIN (measured 2026-07-25, VS Code 1.94.0) ===
    // VS Code's BulkEditService applies a NON-versioned WorkspaceEdit at its
    // FROZEN ranges against the current document — no offset transform, no
    // stale-edit rejection. The pending edit therefore MISPLACES: it splices
    // over "line two" (the stale [2,5]-[2,10] span) and leaves the intended
    // "line three" untouched, while BOTH edits advance the version (1→2→3).
    //
    // This is pinned, not just logged, so a future VS Code version that starts
    // TRANSFORMING or REJECTING stale positional edits fails this test LOUDLY —
    // that would change Slice 6's premise (post-apply verification would drop
    // from load-bearing to belt-and-braces) and must be re-evaluated, not
    // silently absorbed. See the S5 entry in .claude/docs/LEARNING.md.
    assert.strictEqual(
      verdict,
      "MISPLACES",
      "desktop VS Code splices a stale positional edit at frozen offsets (finding #7 confirmed) — " +
        "if this changed, re-evaluate Slice 6"
    );
    assert.strictEqual(
      o.staleApplied,
      true,
      "the stale positional edit was accepted (not rejected)"
    );
    assert.strictEqual(
      o.versionAfterStale - versionBeforeAny,
      2,
      "both the racing edit and the stale edit advanced document.version (2 total)"
    );
  });

  it("records the version delta of an accepted single-span applyEdit (S3a O(1)-fallback premise)", async () => {
    // Validates the premise the S3a perf gate's O(1) alternative rests on:
    // "an accepted single-span applyEdit advances document.version by exactly 1".
    // Measured via a direct apply of the SAME WorkspaceEdit shape the host
    // emits (one `replace` over a minimal range) — authoritative, no reducer
    // interference. The Quoll edit path issues the identical single-span
    // WorkspaceEdit through `applyEditSeam`, so the +1 semantics pinned here
    // hold for it unchanged; driving it through `simulateInbound` as well would
    // add nothing to the version-delta premise (and the first test already
    // exercises the full Quoll apply path end-to-end).
    const base = "alpha bravo charlie\n";
    const uri = await openTemp(base);

    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "expected an active Quoll panel");
    const doc = panel.document;

    // --- Direct single-span probe (authoritative) ---
    const v0 = doc.version;
    const edit = new vscode.WorkspaceEdit();
    // Replace "bravo" (chars 6-11) with "DELTA" — one contiguous span.
    edit.replace(
      uri,
      new vscode.Range(new vscode.Position(0, 6), new vscode.Position(0, 11)),
      "DELTA"
    );
    const ok = await vscode.workspace.applyEdit(edit);
    const v1 = doc.version;

    console.log(
      `[S5-VERDICT] desktop version-delta: singleSpanApplied=${ok} ` +
        `versionBefore=${v0} versionAfter=${v1} delta=${v1 - v0}`
    );

    assert.strictEqual(ok, true, "single-span applyEdit must be accepted");
    assert.strictEqual(
      v1 - v0,
      1,
      "an accepted single-span applyEdit must advance version by exactly 1"
    );
    assert.strictEqual(
      doc.getText(),
      "alpha DELTA charlie\n",
      "the span landed at the intended offsets"
    );
  });
});
