// Minimal stub of the `vscode` module surface for vitest.
//
// The extension host code imports from "vscode", which is only resolvable
// inside a live VS Code runtime. Pure unit tests cannot pull that module,
// so vitest aliases "vscode" to this stub. We only export the surfaces
// actually touched from helpers under test — currently `Uri.joinPath`,
// returning a predictable plain object that can be wrapped by a fake
// `webview.asWebviewUri` in tests.
//
// Keep this file dependency-free and stable: every new helper that imports
// from "vscode" should either avoid the import (preferred) or add a single
// surface here with a one-line rationale.

export type StubUri = { path: string };

export const Uri = {
  // Real vscode.Uri.joinPath resolves `.` / `..` segments. Mirror that here
  // so helpers that derive a parent folder via joinPath(uri, "..") are
  // testable under the stub. Callers passing only plain segments are
  // unaffected (no `.`/`..` to collapse).
  joinPath: (base: StubUri, ...segments: string[]): StubUri => {
    const joined = [base.path, ...segments].join("/");
    const isAbsolute = joined.startsWith("/");
    const out: string[] = [];
    for (const seg of joined.split("/")) {
      if (seg === "" || seg === ".") {
        continue;
      }
      if (seg === "..") {
        out.pop();
        continue;
      }
      out.push(seg);
    }
    return { path: (isAbsolute ? "/" : "") + out.join("/") };
  },
};

// `extension.ts` module-load surface: extension.activate.test.ts asserts
// both Production and Test branches by loading the module under vitest's
// vscode alias. The activate body references commands/window/workspace
// lazily (only when `quoll.editWith` fires), but module-load reads
// ExtensionMode at the type level only — values are read inside activate.
// These no-op stubs let the import + activate call succeed without a
// live host. window.activeTextEditor stays undefined so the inner
// command never reaches its body in tests.
export const ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3,
} as const;

// document-canonical.ts reads document.eol to pick the separator.
// Values match the real vscode.EndOfLine enum (LF = 1, CRLF = 2).
export const EndOfLine = {
  LF: 1,
  CRLF: 2,
} as const;

export const commands = {
  registerCommand: (_id: string, _cb: (...args: unknown[]) => unknown) => ({
    dispose: (): void => undefined,
  }),
  executeCommand: async (..._args: unknown[]): Promise<unknown> => undefined,
};

// Minimal Tabs-API surface. toggle-editor.ts does `import { TabInputCustom }`
// and (in a callback the no-op registerCommand never invokes) reads
// `window.tabGroups`. The import binding must resolve at module load; the
// callback body is never run under vitest, so these can stay bare stubs.
export class TabInputCustom {
  constructor(
    public readonly uri: StubUri,
    public readonly viewType: string
  ) {}
}

export class TabInputText {
  constructor(public readonly uri: StubUri) {}
}

export const window = {
  get activeTextEditor(): unknown {
    return undefined;
  },
  showInformationMessage: (_msg: string): Thenable<undefined> => Promise.resolve(undefined),
  showWarningMessage: (_msg: string): Thenable<undefined> => Promise.resolve(undefined),
  showErrorMessage: (_msg: string): Thenable<undefined> => Promise.resolve(undefined),
  tabGroups: {
    activeTabGroup: { activeTab: undefined as unknown },
  },
};

export const workspace = {
  fs: {
    isWritableFileSystem: (_scheme: string): boolean => true,
  },
  // QuollEditorPanel's constructor reads `quoll.lint.problems.enabled` and
  // subscribes to config changes to gate the Problems lint mirror. Return the
  // caller's default + a no-op disposable so a direct-import unit test that
  // runs the real constructor doesn't crash (no existing test does).
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  }),
  onDidChangeConfiguration: (_listener: (e: unknown) => void) => ({
    dispose: (): void => undefined,
  }),
};

// Stub for `vscode.env`. QuollEditorPanel imports `env` to call
// env.openExternal on inbound open-external messages (C4b). The stub
// returns a settled-true Thenable so non-test paths that never trigger
// open-external are unaffected; tests that exercise the open-external
// arm install a per-test override before importing QuollEditorPanel.
export const env = {
  openExternal: (_url: { toString(): string }): Thenable<boolean> => Promise.resolve(true),
};

// lint-diagnostics.ts converts wire line/character ranges into vscode.Range +
// Diagnostic. Real vscode.DiagnosticSeverity: Error=0, Warning=1,
// Information=2, Hint=3.
export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity: number = DiagnosticSeverity.Error
  ) {}
}

// QuollEditorPanel owns ONE DiagnosticCollection (keyed by uri) for the lint
// mirror. Only extension.activate.test.ts loads the panel module at unit level
// and it mocks `QuollEditorPanel.register`, so this stub is defensive: it keeps
// a future direct-import unit test from tripping over an undefined `languages`.
export const languages = {
  createDiagnosticCollection: (_name?: string) => ({
    set: (_uri: unknown, _diagnostics?: unknown): void => undefined,
    delete: (_uri: unknown): void => undefined,
    clear: (): void => undefined,
    dispose: (): void => undefined,
  }),
};
