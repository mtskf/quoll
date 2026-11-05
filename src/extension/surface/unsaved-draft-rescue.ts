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

const report = (...args: unknown[]): boolean => {
  try {
    console.error(...args);
    return true;
  } catch {
    return false;
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
    const logged = report("[quoll] could not open unsaved draft", cause, draft.content);
    notify(
      deps.showError,
      logged
        ? `Quoll could not open the unsaved draft for ${fsPath}. Copy it from the log: the draft content was logged to the extension host console.`
        : `Quoll could not open the unsaved draft for ${fsPath}, and could not write its content to the extension host console.`
    );
  };
  try {
    void Promise.resolve(deps.openUntitled(draft.content)).then(undefined, failed);
  } catch (err) {
    failed(err);
  }
}
