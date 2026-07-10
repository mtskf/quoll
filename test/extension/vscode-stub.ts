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

// Minimal RelativePattern: helpers under test only construct it (base + glob);
// the real matching happens inside VS Code, exercised by e2e.
export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string
  ) {}
}

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
    all: [] as unknown[],
    onDidChangeTabs: (_listener: (e: unknown) => void) => ({
      dispose: (): void => undefined,
    }),
  },
};

export const workspace = {
  fs: {
    isWritableFileSystem: (_scheme: string): boolean => true,
    // image-write-wiring's writeImage closure calls createDirectory (idempotent
    // assets/ create) before writing. No-op resolves so the unit test's happy
    // path reaches the write override.
    createDirectory: (_uri: unknown): Thenable<void> => Promise.resolve(),
    // Fallback write when no harness override is supplied. The unit test always
    // injects writeFileOverride, so this stays a settled no-op.
    writeFile: (_uri: unknown, _content: Uint8Array): Thenable<void> => Promise.resolve(),
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
  // revert-rescue-wiring's applyRestoreEdit calls workspace.applyEdit. Default
  // resolves true (success); the wiring unit test overrides via vi.spyOn to drive
  // the ok:false / reject failure arms.
  applyEdit: (_edit: unknown): Thenable<boolean> => Promise.resolve(true),
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

// revert-rescue-wiring.ts's applyRestoreEdit builds a WorkspaceEdit (replace the
// changed span) and applies it via workspace.applyEdit. The unit test spies on
// applyEdit to assert the rescue fired (or did not). Only `replace` is recorded;
// the real ordering/positions are exercised by the panel's e2e.
export class WorkspaceEdit {
  public readonly edits: Array<{ uri: unknown; range: unknown; newText: string }> = [];
  replace(uri: unknown, range: unknown, newText: string): void {
    this.edits.push({ uri, range, newText });
  }
}

// context-handoff-wiring.ts imports Selection + ViewColumn at module load (its
// reveal path builds `new Selection(start, end)` and targets ViewColumn.Active).
// esbuild binds a missing named import to `undefined` (throwing only on deref),
// so the current capture-barrier tests pass without these — but the stub's
// contract is to export every surface a helper under test imports. Added so a
// future test that exercises the reveal (hasSelection:true) does not fault on an
// undefined constructor. Selection mirrors the (anchor, active) overload the
// reveal uses; ViewColumn.Active matches the real vscode enum value (-1).
export class Selection {
  constructor(
    public readonly anchor: Position,
    public readonly active: Position
  ) {}
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
} as const;

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
