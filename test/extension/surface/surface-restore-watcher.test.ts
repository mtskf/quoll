import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, TextDocument, Uri } from "vscode";
import { TabInputCustom, TabInputText, window } from "vscode";
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

/** Await a macrotask boundary: drains the ENTIRE microtask queue regardless of
 *  how many awaits the code under test happens to have, so the assertion that
 *  follows pins the behaviour, not the tick count. Draining a fixed number of
 *  ticks would turn one extra await ahead of the observed call into a false
 *  red. (Same role as the `flush` helpers in the wiring tests.) */
const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
    // Every microtask restoreSurface could still take has run by here (see
    // flushTasks), so a close would already be logged if the reopen were not
    // awaited.
    await flushTasks();
    expect(calls).toEqual(["openDoc", "openInQuoll"]);
    releaseOpen();
    await pending;
    expect(calls).toEqual(["openDoc", "openInQuoll", "closeSourceTab"]);
  });

  it("SKIPS a dirty doc entirely — no reopen, no close (passive restore never saves)", async () => {
    // Assert the QUIET path too: restoreSurface swallows every throw, so
    // calls === ["openDoc"] alone cannot distinguish "skipped" from "crashed
    // after openDoc". A silent console.error is the discriminator.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps, calls } = makeRestoreDeps(fakeDoc(true));
      await restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
      expect(calls).toEqual(["openDoc"]);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("SKIPS a Quoll restore onto a read-only filesystem (canEditWith gate)", async () => {
    // Same discriminator as the dirty-doc skip above: a quiet return, not a
    // swallowed throw.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
        isWritableFileSystem: () => false,
      });
      await restoreSurface("quoll", restoreUri, SOURCE_TAB, "quoll.editMarkdown", deps);
      expect(calls).toEqual(["openDoc"]);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
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
      // This log is the only diagnostic channel for restoreSurface's own
      // failures (no toast), so pin the identifying context: without uri +
      // target an openDoc rejection and a reopen rejection are
      // indistinguishable in the output. `err` is pinned too — objectContaining
      // ignores absent keys, so without it a regression that drops the failure
      // payload (leaving a "diagnostic" line with no diagnosis) stays green.
      expect(err).toHaveBeenCalledWith(
        "[quoll] surface restore failed",
        expect.objectContaining({
          uri: "file:///a.md",
          target: "quoll",
          err: expect.any(Error),
        })
      );
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

/** The live tab model the watcher's sibling check reads (`allOpenTabInputs`
 *  flat-maps `window.tabGroups.all`). @types/vscode declares `all` as
 *  `readonly TabGroup[]`, so reaching the stub's mutable array takes one cast —
 *  taken ONCE here rather than at each push. Tests must reset it via
 *  `.length = 0` (never by assigning a fresh array): the stub holds this exact
 *  array reference, and a reassignment here would leave the watcher reading the
 *  old one. */
const stubTabGroups = window.tabGroups.all as unknown as unknown[];

describe("registerSurfaceRestoreWatcher in-flight guard", () => {
  const uriKey = "file:///a.md";

  beforeEach(() => {
    resetStubTabListeners();
    __clearSurfaceMemoryForTest();
    stubTabGroups.length = 0;
  });

  afterEach(() => {
    resetStubTabListeners();
    __clearSurfaceMemoryForTest();
    // Reset on BOTH sides of every case: `tabGroups.all` is shared module state
    // in the vscode stub, so a leaked group would silently flip the sibling
    // check for every later test in THIS file (vitest isolates module state per
    // file, so other files are unaffected).
    stubTabGroups.length = 0;
  });

  /** Fire a synthetic "a text tab for a.md just opened" event at the watcher,
   *  handing back the tab object it synthesised so callers can assert that THAT
   *  tab (not `undefined`, not some other tab) reaches the finalizer. */
  function fireTextOpen(): { input: TabInputText } {
    const tab = { input: new TabInputText(restoreUri) };
    fireTabChange({ opened: [tab] });
    return tab;
  }

  it("suppresses an overlapping restore of the SAME uri while one is in flight", async () => {
    // Several `opened` events for one URI can arrive close together (the
    // watcher's fire-and-forget restore spans them). Without the guard the
    // second text open starts a duplicate restore — and if restore #1 has
    // already opened the Quoll tab, `hasSibling` makes reconcileOpen ADOPT the
    // shown text surface, silently overwriting the remembered "quoll". Hold
    // openDoc pending to keep restore #1 in flight across the second event.
    noteSurface(uriKey, "quoll");
    let releaseDoc: (doc: TextDocument) => void = () => {};
    const docReady = new Promise<TextDocument>((resolve) => {
      releaseDoc = resolve;
    });
    const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
      openDoc: () => {
        calls.push("openDoc");
        return docReady;
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      expect(calls).toEqual(["openDoc"]);
      fireTextOpen();
      expect(calls).toEqual(["openDoc"]); // suppressed by the in-flight guard
      releaseDoc(fakeDoc(false));
      await flushTasks();
    } finally {
      sub.dispose();
    }
  });

  it("RELEASES the guard once the restore settles (a later open restores again)", async () => {
    // Pins the .finally() release: a guard that never cleared would make the
    // feature fire exactly once per URI per session.
    noteSurface(uriKey, "quoll");
    const oneRestore = ["openDoc", "openInQuoll", "closeSourceTab"];
    const { deps, calls } = makeRestoreDeps(fakeDoc(false));
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      await flushTasks();
      expect(calls).toEqual(oneRestore);
      fireTextOpen();
      await flushTasks();
      expect(calls).toEqual([...oneRestore, ...oneRestore]);
    } finally {
      sub.dispose();
    }
  });

  it("releases the guard even when the restore FAILS (a rejection must not wedge the URI)", async () => {
    noteSurface(uriKey, "quoll");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, calls } = makeRestoreDeps(fakeDoc(false), {
      openDoc: async () => {
        calls.push("openDoc");
        throw new Error("boom");
      },
    });
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      await flushTasks();
      fireTextOpen();
      await flushTasks();
      expect(calls).toEqual(["openDoc", "openDoc"]);
    } finally {
      sub.dispose();
      errSpy.mockRestore();
    }
  });

  it("forwards the reconciled TARGET, the uri and the JUST-OPENED tab to restoreSurface", async () => {
    // Call COUNTS alone leave the arguments unpinned: hard-coding the target as
    // "text" (defeating the upgrade-to-Quoll feature entirely) or passing
    // `undefined` as the source tab (closeSourceTabIfClean then returns without
    // closing) both keep a count-only suite green.
    noteSurface(uriKey, "quoll");
    const { deps, args } = makeRestoreDeps(fakeDoc(false));
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      const openedTab = fireTextOpen();
      await flushTasks();
      expect(args.openInQuoll).toEqual([{ uri: restoreUri, viewType: "quoll.editMarkdown" }]);
      expect(args.openInText).toEqual([]);
      // Reference identity, not just shape: `toEqual` is structural, so a
      // different tab object with the same shape would pass — and duplicate
      // text opens for one URI produce exactly such indistinguishable tabs.
      expect(args.closeSourceTab).toHaveLength(1);
      expect(args.closeSourceTab[0]?.tab).toBe(openedTab as unknown as Tab);
      expect(args.closeSourceTab[0]?.uri).toBe(restoreUri);
    } finally {
      sub.dispose();
    }
  });

  it("does NOT restore when the doc is already open in the OTHER surface (side-by-side / mid-swap)", async () => {
    noteSurface(uriKey, "quoll");
    // A live Quoll tab for the same uri — the forward-toggle window in which the
    // text tab opens BEFORE toggle-editor's noteSurface("text") has run. Without
    // the sibling check the watcher would bounce it straight back to Quoll.
    stubTabGroups.push({
      tabs: [{ input: new TabInputCustom(restoreUri, "quoll.editMarkdown") }],
    });
    const { deps, calls } = makeRestoreDeps(fakeDoc(false));
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTextOpen();
      await flushTasks();
      expect(calls).toEqual([]); // sibling ⇒ adopt the shown surface, never bounce
    } finally {
      sub.dispose();
    }
  });

  it("guards PER URI — two different docs opening in ONE batch both restore", async () => {
    // A global in-flight flag instead of the per-uri Set would restore only the
    // first tab of the batch and strand the second.
    const otherUri = {
      scheme: "file",
      path: "/b.md",
      toString: () => "file:///b.md",
    } as unknown as Uri;
    noteSurface(uriKey, "quoll");
    noteSurface("file:///b.md", "quoll");
    const { deps, calls } = makeRestoreDeps(fakeDoc(false));
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTabChange({
        opened: [{ input: new TabInputText(restoreUri) }, { input: new TabInputText(otherUri) }],
      });
      // Synchronous: the handler loops e.opened without awaiting, and
      // restoreSurface calls deps.openDoc before its first await.
      expect(calls).toEqual(["openDoc", "openDoc"]);
      await flushTasks();
    } finally {
      sub.dispose();
    }
  });

  it("does not restore a Quoll tab open (restore is asymmetric, upgrade-only)", async () => {
    noteSurface(uriKey, "text");
    const { deps, calls } = makeRestoreDeps(fakeDoc(false));
    const sub = registerSurfaceRestoreWatcher("quoll.editMarkdown", deps);
    try {
      fireTabChange({
        opened: [{ input: new TabInputCustom(restoreUri, "quoll.editMarkdown") }],
      });
      await flushTasks();
      expect(calls).toEqual([]);
    } finally {
      sub.dispose();
    }
  });

  it("stops reacting after dispose (no stale listener)", async () => {
    noteSurface(uriKey, "quoll");
    const { deps, calls } = makeRestoreDeps(fakeDoc(false));
    registerSurfaceRestoreWatcher("quoll.editMarkdown", deps).dispose();
    fireTextOpen();
    await flushTasks();
    expect(calls).toEqual([]);
  });
});
