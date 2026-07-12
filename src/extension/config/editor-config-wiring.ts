// Host-side editor-surface config wiring for QuollEditorPanel. The editor-config
// side channel (lint-gutter + spellcheck flags) is independent of the
// document/edit lifecycle, so it never enters the host-session core. The config
// is pushed at seed + `ready` (so it lands regardless of which handshake wins)
// and re-pushed on a relevant onDidChangeConfiguration. vscode-free: the panel
// injects the real config subscription (with the `affectsConfiguration` key
// filter) as `subscribe`, and the message build/post as `push`, so the wiring
// gets a direct unit seam. Mirrors dirty-doc-conflict-watcher.ts.

export interface EditorConfigWiringDeps {
  /** Subscribe to config changes; the handler fires ONLY when a key relevant to
   *  the editor surface changed (the panel owns the `affectsConfiguration`
   *  filter). Returns a teardown run on dispose. */
  readonly subscribe: (onRelevantChange: () => void) => () => void;
  /** Build + post the current editor-surface config to the webview. */
  readonly push: () => void;
}

export interface EditorConfigWiring {
  /** Push the current config now — the seed + `ready` handshakes call this so
   *  the config lands regardless of which handshake wins. Idempotent
   *  webview-side. */
  push(): void;
  /** Tear down the config subscription. */
  dispose(): void;
}

export function createEditorConfigWiring(deps: EditorConfigWiringDeps): EditorConfigWiring {
  const unsubscribe = deps.subscribe(deps.push);
  return {
    push(): void {
      deps.push();
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
