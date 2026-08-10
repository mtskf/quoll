// Structural type-equality guard between the E2E suite's local mirror
// (test/extension/e2e/types.ts) and the host-side protocol types
// (src/shared/protocol.ts). The mirror duplicates the wire shapes
// because the E2E test tsconfig's narrow rootDir cannot import across
// from src/; this file uses vitest (which does NOT enforce that
// rootDir) to pin protocol-shape equality at the type level. A drift
// in any of the assertions below is a tsc error at this file —
// surfaced via the AssertEqual identity check at the `const _check:`
// line; the runtime test wrapper is just a vehicle for tsc to run.
//
// Decision: for the e2e-mirror guard above, only protocol-message shapes are
// pinned. RecordedEvent / PanelControls / TestHarness mirrors are
// intentionally looser (e.g. RecordedEventShape's `message` is widened to
// `{ type: string } & Record<string, unknown>` so the e2e tests can
// narrow via the `is*Event` predicates). The protocol-message types
// are where the load-bearing e2e-mirror drift lives.
//
// This file also hosts unrelated tsc-enforced type-level pins for source
// modules (the "handoff type pins" and "status-bar type pins" describe blocks
// below). They are NOT part of the e2e-mirror equality guard above: each pins
// a source-module type contract with a tsc-checked assertion — an AssertEqual
// identity check or a `@ts-expect-error` directive — which is non-vacuous only
// because `pnpm compile` type-checks THIS file.

import { describe, expect, it } from "vitest";
import {
  clampHandoffSelection,
  type HandleContextHandoffPayload,
  type HandoffRevealSelection,
} from "../../src/extension/handoff/handle-context-handoff";
import type { EndOfLineValue } from "../../src/extension/status-bar";
import type { PanelControls } from "../../src/extension/test-harness";
import type {
  DocumentMessage,
  EditMessage,
  EditRejectedMessage,
  HostToWebview,
  ReadyMessage,
  WebviewToHost,
} from "../../src/shared/protocol";
import type {
  DocumentMessageShape,
  EditMessageShape,
  EditRejectedMessageShape,
  HostToWebviewShape,
  PanelControlsShape,
  ReadyMessageShape,
  WebviewToHostShape,
} from "./e2e/types";

type AssertEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe("e2e/types mirror equality", () => {
  it("DocumentMessageShape is structurally identical to DocumentMessage", () => {
    const _check: AssertEqual<DocumentMessage, DocumentMessageShape> = true;
    expect(_check).toBe(true);
  });

  it("ReadyMessageShape is structurally identical to ReadyMessage", () => {
    const _check: AssertEqual<ReadyMessage, ReadyMessageShape> = true;
    expect(_check).toBe(true);
  });

  it("EditMessageShape is structurally identical to EditMessage", () => {
    const _check: AssertEqual<EditMessage, EditMessageShape> = true;
    expect(_check).toBe(true);
  });

  it("WebviewToHostShape is structurally identical to WebviewToHost", () => {
    const _check: AssertEqual<WebviewToHost, WebviewToHostShape> = true;
    expect(_check).toBe(true);
  });

  it("EditRejectedMessageShape is structurally identical to EditRejectedMessage", () => {
    const _check: AssertEqual<EditRejectedMessage, EditRejectedMessageShape> = true;
    expect(_check).toBe(true);
  });

  it("HostToWebviewShape is structurally identical to HostToWebview", () => {
    const _check: AssertEqual<HostToWebview, HostToWebviewShape> = true;
    expect(_check).toBe(true);
  });

  it("PanelControls stays assignable to the looser PanelControlsShape mirror (rawSimulate drift guard)", () => {
    // One-directional assignability (NOT AssertEqual — PanelControlsShape is
    // wider/looser by design, see e2e/types.ts header). Catches a rename or
    // deletion of `rawSimulate` (or any member) in the host-side
    // PanelControls, which would otherwise only surface as a runtime E2E
    // failure.
    const _src = {} as unknown as PanelControls;
    const _drift: PanelControlsShape = _src;
    void _drift;
    expect(true).toBe(true);
  });
});

describe("handoff type pins", () => {
  it("rejects a raw handoff payload where a clamped HandoffRevealSelection is required", () => {
    // HandoffRevealSelection's "clamped + ordered against the live line count"
    // contract used to be documentation-only: the type was structurally
    // identical to the untrusted HandleContextHandoffPayload, so the raw
    // payload could be passed straight to revealForMention, whose
    // implementation calls document.lineAt(endLine - 1) with no re-clamp.
    // The brand makes clampHandoffSelection the only construction point.
    //
    // Lives here (not in the handoff unit test) for the reason spelled out in
    // the status-bar pin below: this file is the one test program `pnpm
    // compile` type-checks, so a @ts-expect-error here is non-vacuous.
    // Revert-check: drop the brand from HandoffRevealSelection and the
    // directive below becomes unused → tsc errors on it.
    const raw = {} as unknown as HandleContextHandoffPayload;
    // @ts-expect-error — a raw payload is not a clamped selection.
    const _drift: HandoffRevealSelection = raw;
    void _drift;
    expect(true).toBe(true);
  });

  it("accepts the clamp helper's result as a HandoffRevealSelection", () => {
    // The other half of the pin: the sole construction point must still
    // produce the branded type (a brand nobody can build is useless).
    const clamped: HandoffRevealSelection = clampHandoffSelection(
      { hasSelection: true, startLine: 1, endLine: 1 },
      1
    );
    expect(clamped).toEqual({ hasSelection: true, startLine: 1, endLine: 1 });
  });

  it("keeps HandoffRevealSelection's data fields readonly", () => {
    // The brand alone only proves an instance was minted through
    // clampHandoffSelection — it says nothing about the fields staying
    // clamped afterwards. Revert-check: drop `readonly` from
    // HandoffRevealSelection's data fields and the directive below becomes
    // unused → tsc errors (TS2578) at this file, which `pnpm compile`
    // type-checks.
    const clamped = clampHandoffSelection({ hasSelection: true, startLine: 1, endLine: 1 }, 1);
    // @ts-expect-error — startLine is readonly; construction-time clamping
    // must not be undoable by later mutation.
    clamped.startLine = 2;
    expect(true).toBe(true);
  });
});

describe("status-bar type pins", () => {
  it("EndOfLineValue stays the two-valued union and nothing wider", () => {
    // Lives here (not in src/extension/status-bar.ts) because this file is
    // the repo's dedicated home for tsc-enforced type-level pins: unlike a
    // test-file `@ts-expect-error`, which would be vacuous under the unit
    // tsconfig's narrow include, this file's AssertEqual check is itself
    // type-checked by `pnpm compile`. Revert-check: widen EndOfLineValue to
    // `number` and this assertion evaluates to `false` — the `= true`
    // assignment fails to typecheck and `pnpm compile` goes red.
    const _check: AssertEqual<EndOfLineValue, 1 | 2> = true;
    expect(_check).toBe(true);
  });
});
