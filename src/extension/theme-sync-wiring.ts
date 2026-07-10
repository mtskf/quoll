// Host-side theme-sync wiring for QuollEditorPanel. VS Code pushes a
// dark/light change via onDidChangeActiveColorTheme; this forwards the mapped
// `isDarkTheme` into the host-session core (dispatch(themeChanged)). Pure side
// channel — never mutates a document. vscode-free (the panel injects the real
// event subscription as `subscribe`), mirroring dirty-doc-conflict-watcher.ts,
// so the wiring gets a direct unit seam.

export interface ThemeSyncWiringDeps {
  /** Subscribe to color-theme changes; the handler receives the mapped
   *  `isDarkTheme`. Returns a teardown run on dispose. */
  readonly subscribe: (onThemeChange: (isDarkTheme: boolean) => void) => () => void;
  /** Forward the theme change (the panel dispatches `themeChanged`). */
  readonly onThemeChange: (isDarkTheme: boolean) => void;
}

export interface ThemeSyncWiring {
  /** Tear down the theme subscription. */
  dispose(): void;
}

export function createThemeSyncWiring(deps: ThemeSyncWiringDeps): ThemeSyncWiring {
  const unsubscribe = deps.subscribe(deps.onThemeChange);
  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
