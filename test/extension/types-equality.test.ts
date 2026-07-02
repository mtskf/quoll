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
// Decision: only protocol-message shapes are pinned. RecordedEvent /
// PanelControls / TestHarness mirrors are intentionally looser
// (e.g. RecordedEventShape's `message` is widened to
// `{ type: string } & Record<string, unknown>` so the e2e tests can
// narrow via the `is*Event` predicates). The protocol-message types
// are where the load-bearing drift lives.

import { describe, expect, it } from "vitest";
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
