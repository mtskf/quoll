// A `window.show<X>Message` Thenable can reject (host detached, dispatcher
// torn down). Every call site across the extension host wants the same
// fire-and-forget safety net — log the rejection under a `[quoll] <label>
// rejected` tag rather than letting it become an unhandled rejection. This
// generalises the pattern first written as QuollEditorPanel's `showError`
// closure so every other show-message call site can share it.

/** Fire-and-forget a `window.show<X>Message(...)` Thenable, logging (not
 *  throwing) if it rejects. `label` names the call for the log line, e.g.
 *  "showErrorMessage" / "showWarningMessage" / "showInformationMessage". */
export function showSafely(thenable: Thenable<unknown>, label: string): void {
  void thenable.then(undefined, (err: unknown) => {
    console.error(`[quoll] ${label} rejected`, err);
  });
}
