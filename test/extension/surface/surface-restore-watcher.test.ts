import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, TextDocument, Uri } from "vscode";
import { TabInputCustom, TabInputText } from "vscode";
import {
  __clearSurfaceMemoryForTest,
  noteSurface,
} from "../../../src/extension/surface/surface-memory.js";
import {
  classifyOpenedTab,
  hasSiblingInOtherSurface,
  planRestore,
  type RestoreDeps,
  registerSurfaceRestoreWatcher,
  restoreSurface,
} from "../../../src/extension/surface/surface-restore-watcher.js";
// Relative import (NOT the "vscode" alias) for the STUB-ONLY helpers, matching
// the precedent at test/extension/handoff/caret-handoff-wiring.test.ts:9: vite
// resolves both paths to the same vscode-stub.ts module instance, so the
// listener the watcher registers via its "vscode" import is the one
// fireTabChange drives — but @types/vscode has no such exports, so importing
// them from "vscode" would flag in the editor today and become a hard error the
// day tsconfig.unit.json's narrow include is widened. TabInputCustom /
// TabInputText stay on "vscode" (they DO exist in @types/vscode).
import { fireTabChange, resetStubTabListeners } from "../vscode-stub.js";

const quollVt = "quoll.editMarkdown";
const mdUri = { toString: () => "file:///a.md", path: "/a.md" } as never;
const txtUri = { toString: () => "file:///a.txt", path: "/a.txt" } as never;

describe("classifyOpenedTab", () => {
  it("classifies a Quoll custom tab as the quoll surface", () => {
    expect(classifyOpenedTab(new TabInputCustom(mdUri, quollVt), quollVt)).toEqual({
      surface: "quoll",
      uri: mdUri,
    });
  });

  it("classifies a markdown text tab as the text surface", () => {
    expect(classifyOpenedTab(new TabInputText(mdUri), quollVt)).toEqual({
      surface: "text",
      uri: mdUri,
    });
  });

  it("ignores a custom tab with a different viewType", () => {
    expect(classifyOpenedTab(new TabInputCustom(mdUri, "other.editor"), quollVt)).toBeNull();
  });

  it("ignores a non-markdown text tab", () => {
    expect(classifyOpenedTab(new TabInputText(txtUri), quollVt)).toBeNull();
  });

  it("ignores an unknown input kind", () => {
    expect(classifyOpenedTab({}, quollVt)).toBeNull();
    expect(classifyOpenedTab(undefined, quollVt)).toBeNull();
  });
});

describe("hasSiblingInOtherSurface", () => {
  const textInput = new TabInputText(mdUri);
  const quollInput = new TabInputCustom(mdUri, quollVt);
  const otherMd = { toString: () => "file:///b.md", path: "/b.md" } as never;

  it("finds a Quoll sibling when a text tab is shown", () => {
    expect(hasSiblingInOtherSurface([quollInput], "file:///a.md", "text", quollVt)).toBe(true);
  });

  it("finds a text sibling when a Quoll tab is shown", () => {
    expect(hasSiblingInOtherSurface([textInput], "file:///a.md", "quoll", quollVt)).toBe(true);
  });

  it("does not count a tab in the SAME surface as a sibling", () => {
    expect(hasSiblingInOtherSurface([textInput], "file:///a.md", "text", quollVt)).toBe(false);
    expect(hasSiblingInOtherSurface([quollInput], "file:///a.md", "quoll", quollVt)).toBe(false);
  });

  it("does not count a different uri as a sibling", () => {
    const otherQuoll = new TabInputCustom(otherMd, quollVt);
    expect(hasSiblingInOtherSurface([otherQuoll], "file:///a.md", "text", quollVt)).toBe(false);
  });

  it("is false for an empty tab list or only unrelated inputs", () => {
    expect(hasSiblingInOtherSurface([], "file:///a.md", "text", quollVt)).toBe(false);
    expect(hasSiblingInOtherSurface([{}, undefined], "file:///a.md", "text", quollVt)).toBe(false);
  });
});

describe("planRestore (pure)", () => {
  it("skips a dirty doc regardless of target (passive restore never saves)", () => {
    expect(planRestore("text", true, true)).toBe("skip");
    expect(planRestore("quoll", true, true)).toBe("skip");
  });

  it("reopens in text when text is remembered and the doc is clean", () => {
    expect(planRestore("text", false, false)).toBe("reopen-text");
  });

  it("reopens in Quoll when quoll is remembered, clean, and editable", () => {
    expect(planRestore("quoll", false, true)).toBe("reopen-quoll");
  });

  it("skips a Quoll restore when the doc cannot be edited with Quoll (readonly/non-file)", () => {
    expect(planRestore("quoll", false, false)).toBe("skip");
  });
});

// Integration coverage of restoreSurface's actual wiring (the reopen→close
// orchestration) through the injectable seam — pins the ordering and the skip /
// failure arms that no E2E happy-path exercises. Mirrors the sibling
// finalizeSurfaceSwap seam tests in surface-swap.test.ts.
const restoreUri = {
  scheme: "file",
  path: "/a.md",
  toString: () => "file:///a.md",
} as unknown as Uri;
const SOURCE_TAB = { id: "source" } as unknown as Tab;

/** Minimal TextDocument fake shaped for canEditWith (uri.scheme / uri.path /
 *  languageId) plus the isDirty planRestore reads. */
function fakeDoc(isDirty: boolean): TextDocument {
  return { uri: restoreUri, languageId: "markdown", isDirty } as unknown as TextDocument;
}

/** Records what each dep was called WITH, not just that it was called. Ordering
 *  assertions alone leave argument fidelity unpinned: passing `undefined` as the
 *  source tab, or the wrong viewType, would keep an order-only suite green while
 *  production stops closing the tab / opens the wrong editor. */
interface RestoreCallArgs {
  openInQuoll: Array<{ uri: Uri; viewType: string }>;
  openInText: Uri[];
  closeSourceTab: Array<{ uri: Uri; tab: Tab | undefined }>;
}

function makeRestoreDeps(
  doc: TextDocument,
  overrides: Partial<RestoreDeps> = {}
): { deps: RestoreDeps; calls: string[]; args: RestoreCallArgs } {
  // A single ordered call log is what makes "reopen BEFORE close" assertable —
  // per-spy call counts cannot express the order.
  const calls: string[] = [];
  const args: RestoreCallArgs = { openInQuoll: [], openInText: [], closeSourceTab: [] };
  const deps: RestoreDeps = {
    openDoc: async () => {
      calls.push("openDoc");
      return doc;
    },
    isWritableFileSystem: () => true,
    openInQuoll: async (uri, viewType) => {
      calls.push("openInQuoll");
      args.openInQuoll.push({ uri, viewType });
    },
    openInText: async (uri) => {
      calls.push("openInText");
      args.openInText.push(uri);
    },
    closeSourceTab: async (uri, tab) => {
      calls.push("closeSourceTab");
      args.closeSourceTab.push({ uri, tab });
    },
    ...overrides,
  };
  return { deps, calls, args };
}

describe("restoreSurface (seamed orchestrator)", () => {
  it("reopens in Quoll, THEN closes the source tab — with the right arguments", async () => {
    const { deps, calls, args } = makeRestoreDeps(fakeDoc(false));
    await restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    expect(calls).toEqual(["openDoc", "openInQuoll", "closeSourceTab"]);
    // Argument fidelity, not just call presence: the viewType must be forwarded
    // (a wrong one opens the wrong editor) and the CAPTURED source tab must reach
    // the finalizer (an undefined tab silently leaves both tabs open).
    expect(args.openInQuoll).toEqual([{ uri: restoreUri, viewType: "quoll.editMarkdown" }]);
    expect(args.closeSourceTab).toEqual([{ uri: restoreUri, tab: SOURCE_TAB }]);
  });

  it("reopens in text, THEN closes the source tab — with the right arguments", async () => {
    const { deps, calls, args } = makeRestoreDeps(fakeDoc(false));
    await restoreSurface("text", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    expect(calls).toEqual(["openDoc", "openInText", "closeSourceTab"]);
    expect(args.openInText).toEqual([restoreUri]);
    expect(args.closeSourceTab).toEqual([{ uri: restoreUri, tab: SOURCE_TAB }]);
  });

  it("does not close the source tab until the reopen has RESOLVED", async () => {
    // The ordering above could also be satisfied by a fire-and-forget open. Pin
    // the await: while the reopen is still pending, the close must not have run
    // — otherwise a failed reopen would have closed the user's only surface.
    let releaseOpen = (): void => {};
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
      openInQuoll: async () => {
        calls.push("openInQuoll");
        await opened;
      },
    });
    const pending = restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["openDoc", "openInQuoll"]);
    releaseOpen();
    await pending;
    expect(calls).toEqual(["openDoc", "openInQuoll", "closeSourceTab"]);
  });

  it("SKIPS a dirty doc entirely — no reopen, no close (passive restore never saves)", async () => {
    const { deps, calls } = makeRestoreDeps(fakeDoc(true));
    await restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    expect(calls).toEqual(["openDoc"]);
  });

  it("SKIPS a Quoll restore onto a read-only filesystem (canEditWith gate)", async () => {
    const { deps, calls } = makeRestoreDeps(fakeDoc(false), { isWritableFileSystem: () => false });
    await restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    expect(calls).toEqual(["openDoc"]);
  });

  it("still reopens in TEXT when the filesystem is read-only (gate is Quoll-only)", async () => {
    const { deps, calls } = makeRestoreDeps(fakeDoc(false), { isWritableFileSystem: () => false });
    await restoreSurface("text", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
    expect(calls).toEqual(["openDoc", "openInText", "closeSourceTab"]);
  });

  it("swallows an openDoc rejection (logs, never throws, never closes)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
        openDoc: async () => {
          throw new Error("no such file");
        },
      });
      await expect(
        restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps)
      ).resolves.toBeUndefined();
      expect(calls).toEqual([]);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("does NOT close the source tab when the reopen rejects (failed restore leaves the valid surface)", async () => {
    // The load-bearing failure arm: if the target surface never opened, closing
    // the source tab would leave the doc with no editor at all.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
        openInQuoll: async () => {
          calls.push("openInQuoll");
          throw new Error("openWith failed");
        },
      });
      await expect(
        restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps)
      ).resolves.toBeUndefined();
      expect(calls).toEqual(["openDoc", "openInQuoll"]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("swallows a closeSourceTab rejection (best-effort finalizer, never throws)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = makeRestoreDeps(fakeDoc(false), {
        closeSourceTab: async () => {
          throw new Error("Invalid tab not found");
        },
      });
      await expect(
        restoreSurface("text", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps)
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("registerSurfaceRestoreWatcher in-flight guard", () => {
  const uriKey = "file:///a.md";

  beforeEach(() => {
    resetStubTabListeners();
    __clearSurfaceMemoryForTest();
  });

  afterEach(() => {
    resetStubTabListeners();
    __clearSurfaceMemoryForTest();
  });

  /** Fire a synthetic "a text tab for a.md just opened" event at the watcher. */
  function fireTextOpen(): void {
    fireTabChange({ opened: [{ input: new TabInputText(restoreUri as never) }] });
  }

  it("suppresses an overlapping restore of the SAME uri while one is in flight", async () => {
    // The watcher's own reopen fires another `opened` event for the same URI;
    // without the guard that event would start a second restore (and, via the
    // now-open sibling, a bounce). Hold openDoc pending to keep restore #1 in
    // flight across the second event.
    noteSurface(uriKey, "quoll");
    let releaseDoc: (doc: TextDocument) => void = () => {};
    const docReady = new Promise<TextDocument>((resolve) => {
      releaseDoc = resolve;
    });
    let openDocCalls = 0;
    const { deps } = makeRestoreDeps(fakeDoc(false), {
      openDoc: () => {
        openDocCalls += 1;
        return docReady;
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      expect(openDocCalls).toBe(1);
      fireTextOpen();
      expect(openDocCalls).toBe(1); // suppressed by the in-flight guard
      releaseDoc(fakeDoc(false));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      sub.dispose();
    }
  });

  it("RELEASES the guard once the restore settles (a later open restores again)", async () => {
    // Pins the .finally() release: a guard that never cleared would make the
    // feature fire exactly once per URI per session.
    noteSurface(uriKey, "quoll");
    let openDocCalls = 0;
    const { deps } = makeRestoreDeps(fakeDoc(false), {
      openDoc: async () => {
        openDocCalls += 1;
        return fakeDoc(false);
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(openDocCalls).toBe(1);
      fireTextOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(openDocCalls).toBe(2);
    } finally {
      sub.dispose();
    }
  });

  it("releases the guard even when the restore FAILS (a rejection must not wedge the URI)", async () => {
    noteSurface(uriKey, "quoll");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let openDocCalls = 0;
    const { deps } = makeRestoreDeps(fakeDoc(false), {
      openDoc: async () => {
        openDocCalls += 1;
        throw new Error("boom");
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      await new Promise((r) => setTimeout(r, 0));
      fireTextOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(openDocCalls).toBe(2);
    } finally {
      sub.dispose();
      errSpy.mockRestore();
    }
  });

  it("does not restore a Quoll tab open (restore is asymmetric, upgrade-only)", async () => {
    noteSurface(uriKey, "text");
    let openDocCalls = 0;
    const { deps } = makeRestoreDeps(fakeDoc(false), {
      openDoc: async () => {
        openDocCalls += 1;
        return fakeDoc(false);
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTabChange({
        opened: [{ input: new TabInputCustom(restoreUri as never, "quoll.editMarkdown") }],
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(openDocCalls).toBe(0);
    } finally {
      sub.dispose();
    }
  });

  it("stops reacting after dispose (no stale listener)", async () => {
    noteSurface(uriKey, "quoll");
    let openDocCalls = 0;
    const { deps } = makeRestoreDeps(fakeDoc(false), {
      openDoc: async () => {
        openDocCalls += 1;
        return fakeDoc(false);
      },
    });
    registerSurfaceRestoreWatcher("quoll.editMarkdown", deps).dispose();
    fireTextOpen();
    await new Promise((r) => setTimeout(r, 0));
    expect(openDocCalls).toBe(0);
  });
});
