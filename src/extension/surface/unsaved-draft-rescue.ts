// Best-effort delivery after close. Recovery ownership and limits:
// ARCHITECTURE.md's surface/unsaved-draft-rescue.ts entry.

export interface UnsavedDraftRescueDeps {
  readonly openUntitled: (content: string) => PromiseLike<unknown>;
  // biome-ignore lint/suspicious/noConfusingVoidType: VS Code notifier may return void or a Thenable.
  readonly showWarning: (message: string) => void | PromiseLike<unknown>;
  // biome-ignore lint/suspicious/noConfusingVoidType: VS Code notifier may return void or a Thenable.
  readonly showError: (message: string) => void | PromiseLike<unknown>;
}

export interface UnsavedDraft {
  readonly content: string;
  readonly reason: string;
}

const report = (...args: unknown[]): void => {
  try {
    console.error(...args);
  } catch {
    // Nothing left to report to.
  }
};

export function rescueUnsavedDraft(
  draft: UnsavedDraft,
  fsPath: string,
  deps: UnsavedDraftRescueDeps
): void {
  const notify = (
    // biome-ignore lint/suspicious/noConfusingVoidType: notifier callbacks share the VS Code return contract.
    send: (message: string) => void | PromiseLike<unknown>,
    message: string
  ): void => {
    try {
      void Promise.resolve(send(message)).catch((err) => {
        report("[quoll] unsaved-draft notification failed", err);
      });
    } catch (err) {
      report("[quoll] unsaved-draft notification failed", err);
    }
  };
  notify(
    deps.showWarning,
    `Quoll could not save an edit to ${fsPath}. Opening the unsaved draft in a new untitled document. Reason: ${draft.reason}`
  );
  const failed = (cause: unknown): void => {
    // Metadata only: the draft is the user's document and the forwarded console
    // is persisted to VS Code's window log; never write document bytes there.
    report("[quoll] could not open unsaved draft", cause, {
      fsPath,
      reason: draft.reason,
      contentLength: draft.content.length,
    });
    // `openUntitled` chains create + show; a failed show can leave the untitled
    // document alive, so never claim the draft is lost.
    notify(deps.showError, `Quoll could not reopen the unsaved draft for ${fsPath}.`);
  };
  try {
    void Promise.resolve(deps.openUntitled(draft.content)).then(undefined, failed);
  } catch (err) {
    failed(err);
  }
}
