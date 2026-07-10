// Host-side context-handoff WIRING for QuollEditorPanel. The two pure handlers
// live in handle-context-handoff.ts (Claude Code tier-0 delegation) and
// handle-codex-context-handoff.ts (Codex whole-file add); the reveal-tab-close
// planner in reveal-for-mention-cleanup.ts. This module owns the VS Code wiring
// AROUND them — the tier-0 activeTextEditor reveal choreography (showTextDocument
// + tab inventory + delta-close + invariant enforcement), the activeTextEditor
// pre-command guard, the Codex single-flight guard, and the edit-settled-barrier
// deferral of both arms. It imports vscode (mirroring disk-conflict-wiring.ts /
// image-write-wiring.ts) because that wiring IS this slice's substance.
//
// PURE SIDE CHANNEL: neither arm EVER enters the host-session reducer or the
// write lock, and neither mutates the document. The factory only READS the
// barrier's published lock state (via the injected editSettledBarrier) to defer
// a handoff behind an in-flight applyEdit so it reads the APPLIED document. The
// vscode-free logic stays pinned by the handle-context-handoff /
// handle-codex-context-handoff / reveal-for-mention-cleanup unit suites + the
// context-handoff-reveal-cleanup / handoff-edit-applied-barrier /
// reveal-for-mention-platform e2e, which this only re-wires.

import type { Tab, TextDocument } from "vscode";
import {
  commands,
  env,
  Position,
  Selection,
  TabInputCustom,
  TabInputText,
  ViewColumn,
  window,
  workspace,
} from "vscode";

import type { EditSettledBarrier } from "./edit-settled-barrier.js";
import { handleCodexContextHandoff } from "./handle-codex-context-handoff.js";
import { handleContextHandoff } from "./handle-context-handoff.js";
import {
  decideRevealInvariant,
  planRevealTabClose,
  type RevealCleanupGroup,
} from "./reveal-for-mention-cleanup.js";

export interface ContextHandoffWiringDeps {
  /** The handed-off document. The factory reads uri / lineCount / isDirty /
   *  save / lineAt from it and owns all reveal choreography against it. */
  readonly document: TextDocument;
  /** QuollEditorPanel.viewType — injected as a string to avoid a panel↔factory
   *  import cycle; used to match this doc's custom tab in the tab inventory. */
  readonly viewType: string;
  /** The edit-applied barrier. Both arms defer through `run(...)` so the handoff
   *  reads the APPLIED document after an in-flight edit settles. */
  readonly editSettledBarrier: EditSettledBarrier;
  /** True once the panel is disposed — each arm drops when disposed (parity with
   *  the panel-level top-of-handleInbound guard). */
  readonly isDisposed: () => boolean;
}

export interface ContextHandoffWiring {
  /** Handle a webview `context-handoff` (Claude Code tier-0 delegation). */
  handleContextHandoff(payload: {
    hasSelection: boolean;
    startLine: number;
    endLine: number;
  }): void;
  /** Handle a webview `codex-context-handoff` (Codex whole-file add). */
  handleCodexContextHandoff(): void;
}

export function createContextHandoffWiring(deps: ContextHandoffWiringDeps): ContextHandoffWiring {
  const { document, viewType, editSettledBarrier } = deps;

  // NOTE: `codexHandoffInFlight` is a LOCAL of this factory function (one per
  // createContextHandoffWiring call = one per panel), NOT a module top-level
  // `let` — a top-level would share the guard across every open document.
  // Single-flight guard for the Codex handoff. A rapid ⌘+J repeat within the
  // async window would add a DUPLICATE, persistent context chip to the Codex
  // sidebar (unlike Claude's transient terminal echo). Reset in the handler's
  // .finally below OR the barrier's onDrop.
  let codexHandoffInFlight = false;

  // Tier-0 reveal for the Claude Code handoff (passed to the pure handler below
  // as HandleContextHandoffDeps.revealForMention — see handle-context-handoff.ts's
  // module header). Claude Code's zero-arg
  // `claude-code.insertAtMentioned` reads window.activeTextEditor (verified
  // against claude-code 2.1.199, re-verified through 2.1.204 — the 2.1.204
  // sibling `claude-vscode.insertAtMention` is the same zero-arg shape), and
  // activeTextEditor only ever points at a
  // VISIBLE text editor — so this document must be shown as a text editor
  // first. The showTextDocument options are pinned by empirical platform
  // facts, probed in a real VS Code host and asserted by
  // test/extension/e2e/reveal-for-mention-platform.test.ts:
  //   - preserveFocus:true NEVER sets activeTextEditor while a custom-editor
  //     tab is active (onDidChangeActiveTextEditor does not fire at all), so
  //     the upstream command silently no-ops — the live bug this replaced.
  //     preserveFocus:false sets activeTextEditor before showTextDocument
  //     even resolves. So the reveal MUST take focus: it moves to the temp
  //     editor for the flash duration and returns when the cleanup's tab
  //     close re-activates the Quoll custom tab.
  //   - ViewColumn.Active (the Quoll custom tab's own group) opens the text
  //     editor as a SECOND tab alongside the custom tab — it does not
  //     replace it — and closing that tab cleanly re-activates the custom
  //     tab with the document still open. In-place face-swap: no layout
  //     shift (the previous ViewColumn.Beside split shifted the layout twice
  //     — once opening, once closing).
  //   - Reuse an already-visible text editor of THIS doc when one exists (no
  //     duplicate tab, cleanup is then a no-op); else open in place
  //     (ViewColumn.Active, brief same-pane flash — the accepted product
  //     cost), preview:true so the temporary tab stays as light as VS Code
  //     allows.
  //   - Cleanup CONTRACT: after cleanup, the Quoll custom tab for this uri
  //     is the ACTIVE tab of its group again. Two phases (the pure planner
  //     lives in reveal-for-mention-cleanup.ts):
  //       (a) close the DELTA text tabs — tabs of this uri in groups that
  //           did NOT already hold one before the reveal (snapshot below),
  //           so the user's own pre-existing text tabs are never closed;
  //       (b) verify the contract and, ONLY when it failed, enforce it via
  //           vscode.openWith. The class phase (a) alone cannot cover: a
  //           background text tab of this doc already in the Quoll group is
  //           not in visibleTextEditors, so the reveal targets
  //           ViewColumn.Active and VS Code REUSES/activates that existing
  //           tab — no delta, nothing to close, and without (b) the pane
  //           stays switched to the raw text editor (the live ⌘⌥K bug
  //           pinned by e2e context-handoff-reveal-cleanup.test.ts).
  // Selection mapping (payload lines are 1-based, clamped + ordered by
  // handleContextHandoff before this is called, with no await in between —
  // lineAt cannot go out of range):
  //   - no selection → empty selection at (0,0) → Claude Code emits the
  //     whole-file `@rel` form.
  //   - selection → (start-1, 0) .. (end-1, endLineLength). The end
  //     character MUST be the end line's text length: Claude Code reads
  //     end.line regardless of character, but with a 0 end-char a
  //     single-line handoff (start === end) would collapse to an EMPTY
  //     selection and wrongly emit the whole-file form. Edge: a single-line
  //     handoff on an EMPTY line unavoidably degrades to the whole-file
  //     mention — accepted.
  const revealForMention = async (selection: {
    hasSelection: boolean;
    startLine: number;
    endLine: number;
  }): Promise<() => Thenable<void>> => {
    const uriString = document.uri.toString();
    const isThisDocTextTab = (tab: Tab): boolean =>
      tab.input instanceof TabInputText && tab.input.uri.toString() === uriString;
    const isThisDocCustomTab = (tab: Tab): boolean =>
      tab.input instanceof TabInputCustom &&
      tab.input.viewType === viewType &&
      tab.input.uri.toString() === uriString;
    // Live tab inventory in the pure planner's shape — see
    // reveal-for-mention-cleanup.ts. Re-taken at each decision point
    // (Tab object identity is not stable across tab-model events).
    const takeTabInventory = (): RevealCleanupGroup<Tab>[] =>
      window.tabGroups.all.map((group) => {
        const customTab = group.tabs.find(isThisDocCustomTab);
        return {
          viewColumn: group.viewColumn,
          // The active-group flag lets decideRevealInvariant reject a custom
          // tab that is active WITHIN its group while focus sits on another
          // group (a same-doc text editor revealed in a separate group).
          isActiveGroup: group.isActive,
          docTextTabs: group.tabs.filter(isThisDocTextTab),
          docCustomTab: customTab === undefined ? null : { isActive: customTab.isActive },
        };
      });
    // Snapshot the groups that already hold a text tab for this doc, keyed
    // by viewColumn (Tab object identity is not stable across tab-model
    // events), so the cleanup can tell a reveal-opened tab from a
    // pre-existing one.
    const groupsWithDocBefore = new Set<ViewColumn>();
    for (const group of window.tabGroups.all) {
      if (group.tabs.some(isThisDocTextTab)) {
        groupsWithDocBefore.add(group.viewColumn);
      }
    }
    const visibleColumn = window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uriString
    )?.viewColumn;
    const end = selection.hasSelection
      ? new Position(selection.endLine - 1, document.lineAt(selection.endLine - 1).text.length)
      : new Position(0, 0);
    const start = selection.hasSelection ? new Position(selection.startLine - 1, 0) : end;
    await window.showTextDocument(document, {
      viewColumn: visibleColumn ?? ViewColumn.Active,
      preserveFocus: false,
      preview: true,
      selection: new Selection(start, end),
    });
    return async () => {
      // Phase (a): close the DELTA text tabs (reveal-opened only). When the
      // reveal reused a pre-existing tab there is no delta — the user's own
      // tab is never closed.
      const toClose = planRevealTabClose(groupsWithDocBefore, takeTabInventory());
      if (toClose.length > 0) {
        await window.tabGroups.close(toClose, true);
        console.info("[quoll] context-handoff cleanup: closed reveal-opened text tab(s)", {
          count: toClose.length,
        });
      } else {
        console.info(
          "[quoll] context-handoff cleanup: no reveal-opened text tab to close (pre-existing tab reused or already gone)"
        );
      }
      // Phase (b): verify the cleanup contract — the Quoll custom tab for
      // this uri is the active tab of its group again — and enforce it only
      // when it provably failed. Enforcement is CONDITIONAL so the common
      // path (the delta close re-activates the custom tab) never runs
      // openWith and cannot fight Claude Code's own panel reveal for focus.
      // The tab model can lag tabGroups.close resolution, so poll briefly
      // before concluding failure (avoids spurious enforcement); a genuine
      // failure is corrected after the ~200 ms budget — imperceptible.
      let decision = decideRevealInvariant(takeTabInventory());
      for (let waited = 0; decision.kind === "enforce" && waited < 200; waited += 40) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        decision = decideRevealInvariant(takeTabInventory());
      }
      if (decision.kind === "enforce") {
        // supportsMultipleEditorsPerDocument:false → openWith re-reveals
        // the EXISTING custom editor (no second instance), and the user's
        // background text tab survives in place — both pinned by the
        // context-handoff-reveal-cleanup e2e.
        console.warn(
          "[quoll] context-handoff cleanup: custom tab not active after cleanup; enforcing via vscode.openWith",
          { viewColumn: decision.viewColumn }
        );
        await commands.executeCommand(
          "vscode.openWith",
          document.uri,
          viewType,
          decision.viewColumn
        );
      } else if (decision.kind === "no-custom-tab") {
        console.warn(
          "[quoll] context-handoff cleanup: no Quoll custom tab for this document; enforcement skipped"
        );
      }
    };
  };

  // Pre-command guard for the tier-0 delegation (see
  // HandleContextHandoffDeps.isDocumentActiveTextEditor): true when
  // window.activeTextEditor currently shows THIS document.
  const isDocumentActiveTextEditor = (): boolean =>
    window.activeTextEditor?.document.uri.toString() === document.uri.toString();

  return {
    handleContextHandoff(payload): void {
      // Direct host-side side effect (no document-state mutation → not a
      // core reducer transition, like image-write). The host owns the
      // path: build it from THIS document's uri, never from the webview.
      // Drop if the panel is already disposed; a handoff already in flight
      // is allowed to settle (panel-level side effect, as with image-write).
      if (deps.isDisposed()) {
        return;
      }
      // Edit-applied barrier: if a flushed edit is still applying (write
      // lock held), DEFER the handoff so its save/clamp/delegation read the
      // applied document, not the pre-edit snapshot. Runs immediately when
      // the lock is free (the common path). `payload` is a fresh object
      // literal built synchronously by the caller — stable across the
      // deferral window (not mutated, cannot be reassigned), so the deferred
      // reads of payload.hasSelection/startLine/endLine are safe.
      editSettledBarrier.run(() => {
        void handleContextHandoff(
          {
            hasSelection: payload.hasSelection,
            startLine: payload.startLine,
            endLine: payload.endLine,
          },
          {
            relativePath: workspace.asRelativePath(document.uri),
            getLineCount: () => document.lineCount,
            isDirty: document.isDirty,
            save: () => document.save(),
            writeClipboard: (text) => env.clipboard.writeText(text),
            executeCommand: (id) => commands.executeCommand(id),
            showInfo: (message) => window.showInformationMessage(message),
            showWarn: (message) => window.showWarningMessage(message),
            showError: (message) => window.showErrorMessage(message),
            // Tier-0 activeTextEditor choreography — hoisted closures above.
            revealForMention,
            isDocumentActiveTextEditor,
          }
        );
      });
    },
    handleCodexContextHandoff(): void {
      // Codex (openai.chatgpt) whole-file handoff. A DISTINCT message type
      // (not a target field on context-handoff): Codex carries no selection
      // geometry (addFileToThread is whole-file only), the Claude arm above
      // stays byte-identical, and an unknown-type host fails closed. Direct
      // side effect (no document-state mutation), same posture as the
      // context-handoff arm. Drop if disposed; a handoff already in flight is
      // allowed to settle (panel-level side effect, as with image-write).
      if (deps.isDisposed()) {
        return;
      }
      if (codexHandoffInFlight) {
        return;
      }
      // Set the single-flight guard at RECEIPT so a rapid ⌘J repeat during
      // the barrier-deferral window is dropped (not queued twice). It is
      // released two ways, exactly one of which fires: the handler's
      // `.finally` when the thunk RUNS, or the barrier's `onDrop` when the
      // thunk is DROPPED (a failed-apply `settle(false)` or a dispose) and
      // never runs. Without the onDrop release, a failed-apply drop while
      // the panel stays ALIVE would strand the guard true and silence every
      // later Codex handoff.
      codexHandoffInFlight = true;
      // Edit-applied barrier: defer the whole-file add behind an in-flight
      // apply so Codex reads the APPLIED file (addFileToThread reads disk
      // after our save()), not the pre-edit snapshot.
      editSettledBarrier.run(
        () => {
          void handleCodexContextHandoff({
            documentUri: document.uri,
            isDirty: document.isDirty,
            save: () => document.save(),
            executeCommand: (id, arg) => commands.executeCommand(id, arg),
            showInfo: (message) => window.showInformationMessage(message),
            showWarn: (message) => window.showWarningMessage(message),
          }).finally(() => {
            codexHandoffInFlight = false;
          });
        },
        () => {
          codexHandoffInFlight = false;
        }
      );
    },
  };
}
