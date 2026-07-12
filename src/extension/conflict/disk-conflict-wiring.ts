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
} from "./disk-conflict.js";

/** Disk-conflict watching applies ONLY to file-scheme documents: a non-file doc
 *  (untitled / virtual / git: / vscode-userdata:) has no backing disk to diverge
 *  from, and createFileSystemWatcher needs a real path. Pure so the gate is a
 *  vscode-free unit seam. */
export function shouldWatchDiskConflicts(scheme: string): boolean {
  return scheme === "file";
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
  /** Make the panel the active editor so the platform revert targets THIS doc. */
  readonly revealPanel: () => void;
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
    readDiskText: async () =>
      Buffer.from(await workspace.fs.readFile(deps.documentUri)).toString("utf8"),
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
    // User-confirmed TRUE revert. revealPanel() makes the panel the active editor
    // so the text-file revert targets THIS document; the platform reload then
    // fires onDidChangeTextDocument → the reducer reseeds the webview with disk
    // content (the same path the clean case rides) AND clears the dirty flag +
    // refreshes VS Code's etag.
    reloadFromDisk: async () => {
      deps.revealPanel();
      await commands.executeCommand("workbench.action.files.revert");
    },
    showError: deps.showError,
  });

  return {
    dispose(): void {
      conflictWatcher.dispose();
      watcher.dispose();
    },
  };
}
