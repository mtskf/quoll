import { describe, expect, it } from "vitest";
import type { Diagnostic, Uri } from "vscode";
import { type LintDiagnosticSink, LintMirror } from "../../../src/extension/lint/lint-mirror.js";

// Minimal Uri fake — LintMirror only calls .toString() for the cache key.
const uriOf = (s: string): Uri => ({ toString: () => s }) as unknown as Uri;
// LintMirror never inspects diagnostic contents; a tagged array is enough to
// assert reference pass-through.
const diags = (tag: string): Diagnostic[] => [{ tag } as unknown as Diagnostic];

function makeSink() {
  const sets: Array<{ uri: string; diagnostics: readonly Diagnostic[] }> = [];
  const deletes: string[] = [];
  let clears = 0;
  const sink: LintDiagnosticSink = {
    set: (uri, diagnostics) => {
      sets.push({ uri: uri.toString(), diagnostics });
    },
    delete: (uri) => {
      deletes.push(uri.toString());
    },
    clear: () => {
      clears += 1;
    },
  };
  return { sink, sets, deletes, clear: () => clears, clearsRef: () => clears };
}

describe("LintMirror", () => {
  it("publishes to the sink when enabled (default-on preserves current behaviour)", () => {
    const { sink, sets } = makeSink();
    const m = new LintMirror(sink, true);
    const d = diags("a");
    m.mirror(uriOf("file:///a.md"), d);
    expect(sets).toEqual([{ uri: "file:///a.md", diagnostics: d }]);
  });

  it("does NOT publish when disabled, but still caches", () => {
    const { sink, sets } = makeSink();
    const m = new LintMirror(sink, false);
    m.mirror(uriOf("file:///a.md"), diags("a"));
    expect(sets).toEqual([]);
  });

  it("setEnabled(false) clears the whole collection", () => {
    const { sink } = makeSink();
    let clears = 0;
    const spy: LintDiagnosticSink = {
      ...sink,
      clear: () => {
        clears += 1;
      },
    };
    const m = new LintMirror(spy, true);
    m.setEnabled(false);
    expect(clears).toBe(1);
  });

  it("setEnabled(true) re-populates every cached document from the last-known set", () => {
    const { sink, sets } = makeSink();
    const m = new LintMirror(sink, false);
    const da = diags("a");
    const db = diags("b");
    m.mirror(uriOf("file:///a.md"), da);
    m.mirror(uriOf("file:///b.md"), db);
    expect(sets).toEqual([]); // suppressed while disabled
    m.setEnabled(true);
    expect(sets).toEqual([
      { uri: "file:///a.md", diagnostics: da },
      { uri: "file:///b.md", diagnostics: db },
    ]);
  });

  it("setEnabled is a no-op when the flag is unchanged (no spurious clear/republish)", () => {
    const { sink, sets } = makeSink();
    let clears = 0;
    const spy: LintDiagnosticSink = {
      ...sink,
      clear: () => {
        clears += 1;
      },
    };
    const m = new LintMirror(spy, true);
    m.mirror(uriOf("file:///a.md"), diags("a"));
    sets.length = 0;
    m.setEnabled(true); // already enabled
    expect(sets).toEqual([]);
    expect(clears).toBe(0);
  });

  it("remove drops the cache entry and deletes from the sink", () => {
    const { sink, sets, deletes } = makeSink();
    const m = new LintMirror(sink, false);
    m.mirror(uriOf("file:///a.md"), diags("a"));
    m.mirror(uriOf("file:///b.md"), diags("b"));
    m.remove(uriOf("file:///a.md"));
    expect(deletes).toEqual(["file:///a.md"]);
    sets.length = 0;
    m.setEnabled(true); // only b should re-populate
    expect(sets).toEqual([{ uri: "file:///b.md", diagnostics: [{ tag: "b" }] }]);
  });
});
