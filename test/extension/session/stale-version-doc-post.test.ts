// @vitest-environment node
//
// Regression pins for the stale-version Document post: a `postDocument` reseed
// posts LIVE document bytes (buildSeedDocument reads document.getText()) but the
// `ready`/`seed`/`viewStateVisible`/`editRejectedDeliveryFailed` arms used to
// stamp the version from the possibly-stale stored `lastAppliedDocVersion`. When
// an external edit is still coalescing in the 100 ms documentChanged debounce
// the wire message pairs new bytes with an OLD version → the webview's next
// keystroke (based on the just-posted version) is judged stale against the live
// version and reseeded away. The arms now snapshot the live `document.version`
// into their event and resync before posting, mirroring the `edit` arm.

import { describe, expect, it } from "vitest";
import { EndOfLine } from "vscode";

import { buildDocumentMessageFromDocument } from "../../../src/extension/session/document-canonical.js";
import {
  createEffectExecutor,
  type EffectExecutor,
} from "../../../src/extension/session/effect-executor.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEvent,
  type HostSessionState,
} from "../../../src/extension/session/host-session-core.js";
import type { HostToWebview } from "../../../src/shared/protocol.js";

const ctx = { uriString: "file:///x.md", fsPath: "/x.md" };
const okValidate = () => ({ ok: true }) as const;
const GEN = 555;
const core = createHostSessionCore(ctx, {
  validateForWrite: okValidate,
  mintEpochGeneration: () => GEN,
});

const state = (over: Partial<HostSessionState> = {}): HostSessionState => ({
  context: ctx,
  lastAppliedDocVersion: 1,
  pendingApplyBaseVersion: null,
  disposed: false,
  rejection: { kind: "none" },
  nextRejectionId: 1,
  pendingEdit: null,
  inFlightContent: null,
  externalEpoch: 0,
  epochGeneration: GEN,
  ...over,
});

describe("stale-version Document post: keystroke is not lost", () => {
  it("viewStateVisible posts the live version, and the base=live keystroke is accepted", () => {
    // Core lags at v1 (external split-editor edit advanced the doc to v2 but its
    // documentChanged is still coalescing in the 100 ms debounce — never
    // dispatched here). The webview becomes visible: the wiring snapshots the
    // LIVE document.version (2) into the event.
    const visible = core.transition(state({ lastAppliedDocVersion: 1 }), {
      type: "viewStateVisible",
      documentVersion: 2,
    });
    // The reseed the webview receives carries the LIVE version (2) — matching
    // the live bytes buildSeedDocument reads. (Old bug: docVersion 1 with v2
    // bytes.) The foreign advance (v1→v2, lock-free) also bumps externalEpoch to 1.
    expect(visible.effects).toEqual([
      { type: "postDocument", docVersion: 2, externalEpoch: 1, epochGeneration: GEN },
    ]);

    // The webview's next keystroke echoes the version it ACTUALLY received on
    // that post, not a value re-derived to match the fix. Read it off the
    // effect above (not hardcoded) so this test genuinely exercises whatever
    // `viewStateVisible` posts.
    const posted = visible.effects[0];
    const receivedVersion = posted.type === "postDocument" ? posted.docVersion : -1;

    // The user types one char, echoing receivedVersion as its base. At edit
    // time the real document is still v2 (independent of what got posted —
    // the live doc doesn't rewind).
    const typed = core.transition(visible.state, {
      type: "edit",
      baseDocVersion: receivedVersion,
      content: "v2 bytes + x",
      documentVersion: 2,
      canWrite: true,
      currentContent: "v2 bytes",
    });
    // Accepted → applyEdit (write). NOT a stale-reseed postDocument that would
    // discard the keystroke. Non-vacuity: under the old stale-version post
    // receivedVersion would be the stale 1; the `edit` arm still resyncs
    // lastAppliedDocVersion to the live 2 (from `documentVersion` above), so
    // decideEdit(base=1, lastApplied=2) returns `stale`, and this would assert
    // a `postDocument` reseed instead of `applyEdit`.
    expect(typed.effects).toEqual([
      { type: "applyEdit", content: "v2 bytes + x", baseDocVersion: receivedVersion },
    ]);
  });
});

describe("stale-version Document post: executor pairs live version with live bytes", () => {
  it("viewStateVisible under a stale core version posts the live version AND live bytes together", () => {
    const coreL = createHostSessionCore(ctx, { validateForWrite: okValidate });
    // Fake mutable document. An external edit advances version+bytes together
    // (as VS Code does), but its documentChanged is still in the 100 ms debounce
    // so the reducer's lastAppliedDocVersion has NOT caught up.
    const fakeDoc = { version: 1, eol: EndOfLine.LF, getText: () => "v1" };

    let live = coreL.initialState(fakeDoc.version); // lastApplied = 1
    const sent: HostToWebview[] = [];

    const dispatchEvent = createDrainingDispatcher((event: HostSessionEvent) => {
      const r = coreL.transition(live, event);
      live = r.state;
      executor.runEffects(r.effects);
    });
    const executor: EffectExecutor = createEffectExecutor({
      isDisposed: () => false,
      getState: () => live,
      uriString: () => ctx.uriString,
      dispatch: dispatchEvent,
      send: async (m) => {
        sent.push(m);
        return true;
      },
      recordEvent: () => {},
      showError: () => {},
      canWrite: () => true,
      // Mirrors the production panel closure: live bytes + the effect's version
      // + the core-managed identity pair.
      buildSeedDocument: (docVersion, externalEpoch, epochGeneration) =>
        buildDocumentMessageFromDocument(fakeDoc, {
          docVersion,
          themeKind: "light",
          canWrite: true,
          externalEpoch,
          epochGeneration,
        }),
      buildRejectedDraft: (content, docVersion, externalEpoch, epochGeneration) =>
        ({
          protocol: 1,
          type: "document",
          content,
          docVersion,
          canWrite: true,
          themeKind: "light",
          externalEpoch,
          epochGeneration,
        }) as HostToWebview,
      buildTheme: (themeKind) => ({ protocol: 1, type: "theme", themeKind }) as HostToWebview,
      buildEditRejected: (error) =>
        ({ protocol: 1, type: "edit-rejected", error }) as HostToWebview,
      applyEditSeam: {
        readText: () => fakeDoc.getText(),
        readVersion: () => fakeDoc.version,
        readCanonical: () => fakeDoc.getText(),
        canonicalize: (text) => text,
        build: () => ({}),
        apply: async () => true,
      },
      openExternal: () => {},
    });

    dispatchEvent({ type: "seed", documentVersion: fakeDoc.version });
    // External edit advances the real document; documentChanged NOT dispatched
    // (still coalescing in the debounce) → core lastApplied stays at 1.
    fakeDoc.version = 2;
    fakeDoc.getText = () => "v2";
    // The webview becomes visible: the panel captures the LIVE version.
    dispatchEvent({ type: "viewStateVisible", documentVersion: fakeDoc.version });

    const lastDoc = sent.filter((m) => m.type === "document").at(-1) as {
      docVersion: number;
      content: string;
    };
    // The reseed pairs the live version (2) with the live bytes ("v2").
    // Old bug: docVersion 1 paired with "v2" bytes → next edit at base 1 is stale.
    expect(lastDoc.docVersion).toBe(2);
    expect(lastDoc.content).toBe("v2");
  });
});
