// Host-side dirty-doc on-disk conflict WIRING for QuollEditorPanel. The pure
// "should we prompt" predicate lives in disk-conflict.ts and the vscode-free
// orchestration (debounce, single-flight, read → prompt → reload flow) lives in
// dirty-doc-conflict-watcher.ts; this module owns the VS Code wiring AROUND that
// orchestration — the file-scheme gate, the parent-folder createFileSystemWatcher,
// and the dep closures (disk read, warning prompt, true revert). It imports
// vscode (mirroring surface-restore-watcher.ts) because that wiring IS this
// slice's substance; keeping it vscode-free would only push the same wiring back
// into the panel. The vscode-free unit seam is the pure shouldWatchDiskConflicts
// gate; the divergence/prompt/reload flow stays pinned by dirty-doc-conflict-
// watcher's unit suite + the dirty-doc-disk-conflict e2e, which this only re-wires.

import { commands, RelativePattern, Uri, window, workspace } from "vscode";

import {
  createDirtyDocConflictWatcher,
  type DirtyDocConflictWatcher,
} from "./dirty-doc-conflict-watcher.js";
import {
  DISK_CONFLICT_KEEP,
  DISK_CONFLICT_MESSAGE,
  DISK_CONFLICT_RELOAD,
  decodeComparableUtf8,
} from "./disk-conflict.js";

/** Disk-conflict watching applies ONLY to file-scheme documents: a non-file doc
 *  (untitled / virtual / git: / vscode-userdata:) has no backing disk to diverge
 *  from, and createFileSystemWatcher needs a real path. Pure so the gate is a
 *  vscode-free unit seam. */
export function shouldWatchDiskConflicts(scheme: string): boolean {
  return scheme === "file";
}

/** Default window to wait for THIS panel to become the active editor after a
 *  reveal before giving up (and skipping the revert). Short so a miss degrades
 *  promptly to the manual-revert toast; the unit suite overrides it small. */
export const CONFIRM_ACTIVE_TIMEOUT_MS = 500;

export interface ActiveGatedRevertDeps {
  /** True once the panel is disposed. Re-read in every async callback. */
  readonly isDisposed: () => boolean;
  /** True iff THIS panel is currently the active editor. (Panel adapter: reads
   *  webviewPanel.active, which THROWS after dispose — hence the isDisposed
   *  guards below read it only when not disposed.) */
  readonly isActive: () => boolean;
  /** Make the panel visible + focused (webviewPanel.reveal). */
  readonly reveal: () => void;
  /** Subscribe to this panel's view-state changes; returns an unsubscribe. */
  readonly subscribeViewStateChange: (onChange: () => void) => () => void;
  /** Perform the argument-less platform revert of the active editor. */
  readonly revert: () => Promise<void>;
  /** Confirm-active timeout in ms. Defaults to CONFIRM_ACTIVE_TIMEOUT_MS. */
  readonly confirmTimeoutMs?: number;
}

/** Build the `reloadFromDisk` closure: confirm THIS panel is the active editor,
 *  then run the argument-less platform revert ONLY when it is. VS Code 1.94 has
 *  no URI-scoped revert command — `workbench.action.files.revert` reverts the
 *  ACTIVE editor and ignores any argument (verified against the 1.94
 *  `fileCommands.ts`). Firing it while some OTHER dirty editor is active would
 *  discard that unrelated file, so we gate on active and, if the panel never
 *  becomes active, skip — the watcher's still-dirty post-condition then surfaces
 *  the manual "File: Revert File" toast (no data loss). Vscode-free so the
 *  ordering-critical async/dispose logic is a unit seam. */
export function buildActiveGatedRevert(deps: ActiveGatedRevertDeps): () => Promise<void> {
  const timeoutMs = deps.confirmTimeoutMs ?? CONFIRM_ACTIVE_TIMEOUT_MS;
  const confirmActive = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (deps.isDisposed()) {
        resolve(false);
        return;
      }
      if (deps.isActive()) {
        resolve(true);
        return;
      }
      deps.reveal();
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(value);
      };
      // Re-check isDisposed in BOTH async callbacks BEFORE reading isActive: the
      // panel adapter's isActive() touches webviewPanel, which THROWS after
      // dispose. Guarding resolves false cleanly; without it the read throws
      // inside the timer/handler (outside this executor) → the Promise never
      // settles → the whole reload hangs and the watcher's single-flight flag
      // never releases (permanently wedged, no further conflict prompts).
      const teardown = deps.subscribeViewStateChange(() => {
        if (deps.isDisposed()) {
          finish(false);
          return;
        }
        if (deps.isActive()) {
          finish(true);
        }
      });
      // If subscribe fired onChange SYNCHRONOUSLY, `finish` already ran while
      // `unsubscribe` was still the initial no-op — the real subscription would
      // leak. Tear it down now and skip arming a timer we'd leak too. (VS Code's
      // onDidChangeViewState does not fire synchronously, so this is a
      // correct-by-construction guard against a future adapter swap, not a live
      // bug.) Otherwise wire the teardown + the fallback timeout normally.
      if (settled) {
        teardown();
        return;
      }
      unsubscribe = teardown;
      timer = setTimeout(() => finish(deps.isDisposed() ? false : deps.isActive()), timeoutMs);
    });
  return async () => {
    if (await confirmActive()) {
      await deps.revert();
    }
  };
}

export interface DiskConflictWiringDeps {
  /** The watched document's URI. Its `.scheme` gates the watcher; its parent
   *  folder is the watch root and it is the disk-read / URI-filter target. */
  readonly documentUri: Uri;
  /** True once the panel is disposed — the orchestration re-checks it after each
   *  await (this stays lazy; disposal can race an in-flight prompt/read). */
  readonly isDisposed: () => boolean;
  /** Live dirty flag of the model (the precondition for a conflict). Lazy. */
  readonly isDirty: () => boolean;
  /** Canonical in-memory buffer text, for the divergence compare. Lazy. */
  readonly readBufferText: () => string;
  /** Getter for the test override of the warning prompt
   *  (harness.diskConflictPromptOverride) — read PER PROMPT (it can be set after
   *  resolve). null routes to window.showWarningMessage. */
  readonly promptOverride: () =>
    | ((message: string, ...actions: string[]) => Thenable<string | undefined>)
    | null;
  /** Make the panel visible + focused so the (active-editor-scoped) platform
   *  revert can target THIS document. Paired with isPanelActive /
   *  subscribePanelViewStateChange (see buildActiveGatedRevert). */
  readonly revealPanel: () => void;
  /** True iff THIS panel is currently the active editor (reads
   *  webviewPanel.active). Read only when not disposed. */
  readonly isPanelActive: () => boolean;
  /** Subscribe to this panel's view-state changes; returns an unsubscribe. */
  readonly subscribePanelViewStateChange: (onChange: () => void) => () => void;
  /** Surface an error toast. */
  readonly showError: (message: string) => void;
}

export interface DiskConflictWiring {
  /** Cancel any pending debounce and tear down the fs watcher + its listeners. */
  dispose(): void;
}

export function createDiskConflictWiring(deps: DiskConflictWiringDeps): DiskConflictWiring {
  // file-scheme only: createFileSystemWatcher needs a real path, and a non-file
  // doc (untitled / virtual) has no backing disk to diverge from.
  if (!shouldWatchDiskConflicts(deps.documentUri.scheme)) {
    return { dispose() {} };
  }

  // Watch the parent directory with a plain `*` and filter by URI in the
  // orchestration, rather than globbing the basename directly: a filename with
  // glob metacharacters (e.g. `notes[1].md`, `a{b}.md`) would otherwise miss or
  // mis-match (Codex C88). `*` is non-recursive — direct children only — so this
  // stays scoped to the document's own folder.
  const watcher = workspace.createFileSystemWatcher(
    new RelativePattern(Uri.joinPath(deps.documentUri, ".."), "*"),
    false, // ignoreCreate: an atomic save (temp + rename) can surface as create
    false, // ignoreChange: the common in-place external write
    true // ignoreDelete: a deleted backing file is the platform's UX, not a content conflict
  );

  const conflictWatcher: DirtyDocConflictWatcher = createDirtyDocConflictWatcher({
    // onDidChange + onDidCreate are the divergence signals; the orchestration
    // filters by URI and debounces. The teardown disposes both listeners.
    subscribe: (onSignal) => {
      const subs = [
        watcher.onDidChange((changed) => onSignal(changed.toString())),
        watcher.onDidCreate((changed) => onSignal(changed.toString())),
      ];
      return () => {
        for (const sub of subs) {
          sub.dispose();
        }
      };
    },
    documentUriString: deps.documentUri.toString(),
    isDisposed: deps.isDisposed,
    isDirty: deps.isDirty,
    readDiskText: async () => decodeComparableUtf8(await workspace.fs.readFile(deps.documentUri)),
    readBufferText: deps.readBufferText,
    promptReload: () => {
      const override = deps.promptOverride();
      return override
        ? override(DISK_CONFLICT_MESSAGE, DISK_CONFLICT_RELOAD, DISK_CONFLICT_KEEP)
        : window.showWarningMessage(
            DISK_CONFLICT_MESSAGE,
            DISK_CONFLICT_RELOAD,
            DISK_CONFLICT_KEEP
          );
    },
    reloadChoice: DISK_CONFLICT_RELOAD,
    // User-confirmed TRUE revert, GATED on this panel becoming active first (see
    // buildActiveGatedRevert). The platform reload then fires
    // onDidChangeTextDocument → the reducer reseeds the webview with disk content
    // AND clears the dirty flag + refreshes VS Code's etag. If the panel never
    // becomes active, the revert is skipped and the watcher's still-dirty
    // post-condition surfaces the manual revert toast — never a revert of an
    // unrelated active editor.
    reloadFromDisk: buildActiveGatedRevert({
      isDisposed: deps.isDisposed,
      isActive: deps.isPanelActive,
      reveal: deps.revealPanel,
      subscribeViewStateChange: deps.subscribePanelViewStateChange,
      revert: () => commands.executeCommand("workbench.action.files.revert") as Promise<void>,
    }),
    showError: deps.showError,
  });

  return {
    dispose(): void {
      conflictWatcher.dispose();
      watcher.dispose();
    },
  };
}
