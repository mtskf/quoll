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
// modules (the "handoff type pins", "table model type pins", "status-bar
// type pins", "host-session step type pins", and "document-write adapter
// type pins" describe blocks below). They are NOT part of the e2e-mirror
// equality guard above: each pins a source-module type contract with a
// tsc-checked assertion — an AssertEqual identity check or a
// `@ts-expect-error` directive — which is non-vacuous only because
// `pnpm compile` type-checks THIS file.

import { describe, expect, it } from "vitest";
import type { DocumentWriteAdapter } from "../../src/extension/document-write/execute-write";
import {
  clampHandoffSelection,
  type HandleContextHandoffPayload,
  type HandoffRevealSelection,
} from "../../src/extension/handoff/handle-context-handoff";
import type {
  HostSessionEvent,
  HostSessionInputEvent,
} from "../../src/extension/session/host-session-core";
import type { HostSessionStepDeps } from "../../src/extension/session/host-session-step";
import type { EndOfLineValue } from "../../src/extension/status-bar";
import type { PanelControls } from "../../src/extension/test-harness";
import type { Cell, DelimiterCell, DelimiterRow, Row, Table } from "../../src/markdown/table/model";
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

describe("table model type pins", () => {
  it("keeps every field and array of the GFM table model readonly", () => {
    // makeTable's header/delimiter cell-count check is a CONSTRUCTION-time
    // gate; it only stays true afterwards if nothing can write into the model
    // it returned. `readonly` throughout is what makes that hold, and these
    // assertions are what keep it from being dropped silently.
    //
    // Lives here for the reason the status-bar pin spells out: no tsconfig
    // type-checks test/markdown, so the same assertion next to the model's own
    // unit test would be erased by vitest's transpile-only path and never fail.
    //
    // `Readonly<T>` is homomorphic, so `AssertEqual<T, Readonly<T>>` holds only
    // when EVERY field of T is already readonly — including fields added later,
    // which a per-field `@ts-expect-error` would stop covering the moment the
    // shape grows. Revert-check: drop `readonly` from any single field below
    // and its assertion resolves to `false`, failing the `= true` assignment.
    const _table: AssertEqual<Table, Readonly<Table>> = true;
    const _row: AssertEqual<Row, Readonly<Row>> = true;
    const _cell: AssertEqual<Cell, Readonly<Cell>> = true;
    const _delimiterRow: AssertEqual<DelimiterRow, Readonly<DelimiterRow>> = true;
    const _delimiterCell: AssertEqual<DelimiterCell, Readonly<DelimiterCell>> = true;
    // Readonly<T> is SHALLOW: it freezes the `cells` field but not the array it
    // holds, so the collections need their own pins. A mutable `Row[]` is not
    // structurally equal to `readonly Row[]` (it carries push/splice/index-set).
    const _rows: AssertEqual<Table["rows"], readonly Row[]> = true;
    const _cells: AssertEqual<Row["cells"], readonly Cell[]> = true;
    const _delimiterCells: AssertEqual<DelimiterRow["cells"], readonly DelimiterCell[]> = true;
    expect(
      _table &&
        _row &&
        _cell &&
        _delimiterRow &&
        _delimiterCell &&
        _rows &&
        _cells &&
        _delimiterCells
    ).toBe(true);
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

describe("host-session step type pins", () => {
  it("keeps HostSessionStepDeps' write-lock recovery dep REQUIRED", () => {
    // `commitWriteLockRecovery` is the panel's only path to releasing a write
    // lock that a THROWING `applyEditSettled` transition left held. The dep's
    // own doc says "REQUIRED, not optional: a no-op default would let a call
    // site forget the wiring and keep the stranded-lock bug with every test
    // green" — and until this pin, nothing enforced it. Adding `?` plus a
    // `?? (() => [])` default compiles clean, and because
    // `test/extension/session/` is in NO tsconfig (vitest is transpile-only
    // there), a harness that omits the dep raises a runtime `TypeError` that
    // `recoverStrandedWriteLock`'s own `try` funnels into `onSettleError` — the
    // test still PASSES while measuring no recovery at all.
    //
    // Lives here for the reason the status-bar and table-model pins spell out:
    // this file is type-checked by `pnpm compile`, so the assertion is
    // non-vacuous. `Required<T>` is homomorphic, so the identity holds only
    // while the picked member carries no `?`. Revert-check: add `?` to
    // `commitWriteLockRecovery` and this resolves to `false`, failing the
    // `= true` assignment. The technique's non-vacuity is measured against the
    // deliberately OPTIONAL `onSettleError`, for which the same assertion
    // fails — that member is the control, and is deliberately not pinned here.
    const _check: AssertEqual<
      Pick<HostSessionStepDeps, "commitWriteLockRecovery">,
      Required<Pick<HostSessionStepDeps, "commitWriteLockRecovery">>
    > = true;
    expect(_check).toBe(true);
  });

  it("keeps `settlementTransitionFailed` OUT of the dispatchable event union", () => {
    // `HostSessionInputEvent` derives from `Exclude`, and `Exclude<T, U>` is
    // `T extends U ? never : T` — a non-matching `U` returns `T` UNCHANGED with
    // no error, so the derive is fail-OPEN. Measured BEFORE this pin existed: a
    // one-character typo in the excluded literal left the whole of `pnpm compile`
    // green AND re-admitted the forbidden
    // `deps.dispatch({ type: "settlementTransitionFailed", … })`,
    // which is the dispatch the type exists to forbid (a queued recovery lands
    // behind a sibling that takes the lock-held stash arm, and the recovery then
    // drops that stash). The sibling derive in the same commit,
    // `host-session-step.ts`'s `SettlementEvent` `Extract`, is fail-CLOSED — it
    // collapses to `never` on a typo and reddens its callers — so without this
    // pin one commit ships two derives with OPPOSITE failure modes.
    //
    // It takes TWO assertions to say this — and a third, below, to close the
    // one vacuity the pair shares — because either one alone is
    // satisfiable without the invariant holding. `Extract<T, U>` answers `never`
    // for two different reasons — the union really excludes the member
    // (intended), or the literal matches nothing at all (vacuous) — and it cannot
    // distinguish them. The cause is structural, and the sibling pin above is the
    // contrast that proves it: `Pick<T, K>` declares `K extends keyof T`, so ITS
    // key typo is a TS2344, while `Extract`'s `U` is unconstrained — which is
    // exactly why `Exclude` is fail-OPEN at the source in the first place.
    //
    // So: ONE literal, asked TWO questions. It must be a REAL member of the WIDE
    // union, AND absent from the narrow one. Writing the literal ONCE is what
    // makes that a biconditional rather than a convention — with a literal per
    // assertion, mistyping the exclusion side's copy leaves the membership side
    // reading its own correct copy, and the pair goes green while the guard is
    // silently disarmed (measured: exit 0). There is no pair to keep in sync now.
    //
    // Measured on THIS form (`tsc -p test/extension/tsconfig.unit.json`):
    //   - mistype `host-session-core.ts`'s `Exclude` literal → TS2322
    //     (`_excludesRecovery`);
    //   - mistype `RecoveryEventType` → TS2322 (`_recoveryIsARealMember`; this is
    //     also the rename-and-forget case, where `Exclude` stops removing
    //     anything and the exclusion question alone would still answer `never`).
    //   - `type RecoveryEventType = never` → TS2322 (`_aliasIsNotNever`). That
    //     degenerate value makes the two questions above trivially true, and no
    //     typo produces it (every misspelling is a non-empty literal, which
    //     always reddens one half) — but a refactor that COMPUTES this type
    //     could, so the third assertion asks the alias about itself.
    type RecoveryEventType = "settlementTransitionFailed";
    const _recoveryIsARealMember: AssertEqual<
      Extract<HostSessionEvent, { readonly type: RecoveryEventType }>["type"],
      RecoveryEventType
    > = true;
    const _excludesRecovery: AssertEqual<
      Extract<HostSessionInputEvent, { readonly type: RecoveryEventType }>,
      never
    > = true;
    const _aliasIsNotNever: AssertEqual<
      [RecoveryEventType] extends [never] ? true : false,
      false
    > = true;
    expect(_recoveryIsARealMember).toBe(true);
    expect(_excludesRecovery).toBe(true);
    expect(_aliasIsNotNever).toBe(true);
  });
});

describe("document-write adapter type pins", () => {
  // A stand-in for production's `WorkspaceEdit`. Nothing here inspects an edit —
  // the point is only that ONE type flows from `build` into `apply`.
  type Marker = { readonly marker: "edit" };

  it("threads one edit type from build into apply (no erasure to unknown)", () => {
    // The adapter's whole job at the type level is to say "whatever `build`
    // makes is what `apply` takes". Both sides used to be `unknown`, which
    // erased that relation and forced every call site to re-assert it with an
    // unchecked `edit as WorkspaceEdit`. Revert either side to `unknown` and the
    // matching assertion below evaluates to `false`, so the `= true` assignment
    // fails and `pnpm compile` goes red.
    //
    // ⚠️ The sibling half of that change — `apply` returning `PromiseLike` rather
    // than the ambient `Thenable` `@types/vscode` installs — is NOT pinnable
    // here, and the omission is deliberate rather than forgotten: `Thenable<T>`
    // is declared as `interface Thenable<T> extends PromiseLike<T> {}`, i.e.
    // structurally identical, so no type-level assertion can tell the two apart.
    const _build: AssertEqual<ReturnType<DocumentWriteAdapter<Marker>["build"]>, Marker> = true;
    const _apply: AssertEqual<Parameters<DocumentWriteAdapter<Marker>["apply"]>[0], Marker> = true;
    expect(_build && _apply).toBe(true);
  });

  it("requires the edit type argument — no default that silently re-erases it", () => {
    // A default (`<TEdit = unknown>`) would restore the erasure for every bare
    // annotation, AND — `apply` being a property, so contravariant under
    // strictFunctionTypes — would then REJECT a correctly typed literal, which is
    // what invites the casts back. Revert-check: add a default and the directive
    // below becomes unused → tsc errors (TS2578) at this file.
    // @ts-expect-error — DocumentWriteAdapter requires its edit type argument.
    type _Bare = DocumentWriteAdapter;
    expect(true).toBe(true);
  });
});
