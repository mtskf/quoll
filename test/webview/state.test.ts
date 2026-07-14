import { describe, expect, it } from "vitest";

import type { MarkdownError } from "../../src/markdown/errors.js";
import type { ThemeKind } from "../../src/shared/protocol.js";
import {
  type Action,
  canPostEdit,
  initialState,
  reducer,
  type WebviewState,
} from "../../src/webview/state.js";

// The reducer is the spec for webview UI/protocol state. Content lives only
// in CodeMirror's EditorState; the reducer must never carry it. Every test
// here also pins reducer purity — same (state, action) always returns the
// same next state, no clock / random / global reads.

const docAction = (
  overrides: Partial<{
    docVersion: number;
    canWrite: boolean;
    themeKind: ThemeKind;
  }> = {}
) =>
  ({
    type: "document",
    docVersion: 1,
    canWrite: true,
    themeKind: "dark",
    ...overrides,
  }) as const;

const serializeError: MarkdownError = {
  code: "invalid_frontmatter",
  message: "Frontmatter body contains a bare `---` line",
};

describe("reducer — content not in state", () => {
  it("WebviewState type does not expose a `content` field at the boundary", () => {
    // Compile-time + runtime check: enumerate keys and assert `content` is
    // absent. CodeMirror's EditorState is the single source of truth for
    // document content.
    const seen = reducer(initialState, docAction({ docVersion: 5 }));
    expect(Object.keys(seen)).not.toContain("content");
    expect(Object.keys(initialState)).not.toContain("content");
  });
});

describe("reducer — exhaustiveness guard", () => {
  it("throws on an unknown action type (fail loud, not silent return)", () => {
    // The default arm is unreachable by type — `Action` is a closed union —
    // so we cast past the type system to exercise the runtime guard. It must
    // THROW (shared failure mode with shell.ts's HostToWebview guard), not
    // silently return the current state or the unknown action object.
    const unknown = { type: "no-such-action" } as unknown as Action;
    expect(() => reducer(initialState, unknown)).toThrow(/unhandled Action: no-such-action/);
  });
});

describe("reducer — ready transitions on Document arrival", () => {
  it("initial state is not ready", () => {
    expect(initialState.ready).toBe(false);
  });

  it("first non-stale Document sets ready=true", () => {
    const next = reducer(initialState, docAction({ docVersion: 1 }));
    expect(next.ready).toBe(true);
    expect(next.docVersion).toBe(1);
  });

  it("ready stays true across subsequent Documents", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, docAction({ docVersion: 2 }));
    expect(b.ready).toBe(true);
  });
});

describe("reducer — docVersion comparison rule (>= displayed)", () => {
  // The two-comparison rule: the webview accepts a Document iff
  // incoming.docVersion >= displayed. The comparison is inlined here on
  // purpose — there is no `isLaterVersion` helper.

  it("accepts strictly newer Document and advances docVersion", () => {
    const a = reducer(initialState, docAction({ docVersion: 3 }));
    const b = reducer(a, docAction({ docVersion: 7 }));
    expect(b.docVersion).toBe(7);
  });

  it("accepts equal-version Document (>= rule)", () => {
    const a = reducer(initialState, docAction({ docVersion: 4 }));
    const b = reducer(a, docAction({ docVersion: 4, canWrite: false }));
    expect(b.docVersion).toBe(4);
    expect(b.canWrite).toBe(false);
  });

  it("drops strictly older Document and returns the same state reference", () => {
    const a = reducer(initialState, docAction({ docVersion: 9 }));
    const b = reducer(a, docAction({ docVersion: 5, canWrite: false }));
    expect(b).toBe(a);
    expect(b.docVersion).toBe(9);
    expect(b.canWrite).toBe(true);
  });
});

describe("reducer — canWrite follows latest non-stale Document", () => {
  it("flips from true to false on a fresh Document", () => {
    const a = reducer(initialState, docAction({ docVersion: 1, canWrite: true }));
    const b = reducer(a, docAction({ docVersion: 2, canWrite: false }));
    expect(b.canWrite).toBe(false);
  });

  it("stale Document does not affect canWrite", () => {
    const a = reducer(initialState, docAction({ docVersion: 4, canWrite: true }));
    const b = reducer(a, docAction({ docVersion: 1, canWrite: false }));
    expect(b.canWrite).toBe(true);
  });
});

describe("reducer — editInFlight single-flight invariant", () => {
  it("post-edit advances editInFlight when guards pass", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "post-edit" });
    expect(b.editInFlight).toBe(true);
  });

  it("second post-edit while one is in flight is a no-op", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "post-edit" });
    const c = reducer(b, { type: "post-edit" });
    expect(c).toBe(b);
  });

  it("non-stale Document clears editInFlight", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "post-edit" });
    expect(b.editInFlight).toBe(true);
    const c = reducer(b, docAction({ docVersion: 2 }));
    expect(c.editInFlight).toBe(false);
  });

  it("stale Document does NOT clear editInFlight", () => {
    const a = reducer(initialState, docAction({ docVersion: 5 }));
    const b = reducer(a, { type: "post-edit" });
    const c = reducer(b, docAction({ docVersion: 2 }));
    expect(c.editInFlight).toBe(true);
  });

  // Design debt acknowledged: pinning the reducer's same-`docVersion`
  // Document = "clear editInFlight" behaviour overloads the same code path
  // for two intents (post-applyEdit ack and visible-transition resync).
  // Acceptable because the host now silently drops inbound Edits during the
  // write lock (QuollEditorPanel inbound-Edit silent-drop arm) so no third
  // source of same-`docVersion` Documents can race. The cleaner long-term
  // fix is a dedicated `ack` message in a future protocol revision; deferred
  // because it requires coordinated reducer + protocol changes.
  it("same-docVersion Document re-applies state (visible-transition reset)", () => {
    // The host posts a Document on onDidChangeViewState (visible edge) AND
    // on onDidChangeTextDocument. A hidden→visible transition immediately
    // after an external edit can dispatch two Documents with the same
    // docVersion back to back. The reducer treats the second one as a
    // fresh apply (editInFlight: false). This is the *intended*
    // visible-transition reset — pin it so a future "early-return on equal
    // docVersion" refactor cannot silently change behaviour.
    const seeded = reducer(initialState, docAction({ docVersion: 3 }));
    expect(seeded.editInFlight).toBe(false);
    expect(seeded.ready).toBe(true);
    expect(seeded.docVersion).toBe(3);

    const afterPostEdit = reducer(seeded, { type: "post-edit" });
    expect(afterPostEdit.editInFlight).toBe(true);

    // Same-docVersion Document arrives (e.g. visibility resync). The
    // reducer overwrites in place — it does NOT short-circuit to the
    // previous state — clearing editInFlight and resetting serializeError
    // from the action payload.
    const afterResync = reducer(afterPostEdit, {
      type: "document",
      docVersion: 3,
      canWrite: true,
      themeKind: "dark",
    });
    expect(afterResync.editInFlight).toBe(false);
    expect(afterResync.docVersion).toBe(3);
    expect(afterResync.ready).toBe(true);
    expect(afterResync.serializeError).toBeNull();
  });

  it("post-edit is dropped when canWrite is false", () => {
    const a = reducer(initialState, docAction({ docVersion: 1, canWrite: false }));
    const b = reducer(a, { type: "post-edit" });
    expect(b.editInFlight).toBe(false);
    expect(b).toBe(a);
  });
});

describe("reducer — theme updates do not touch docVersion", () => {
  it("theme action preserves docVersion", () => {
    const a = reducer(initialState, docAction({ docVersion: 9, themeKind: "dark" }));
    const b = reducer(a, { type: "theme", themeKind: "light" });
    expect(b.theme).toBe("light");
    expect(b.docVersion).toBe(9);
  });

  it("theme action preserves editInFlight", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "post-edit" });
    const c = reducer(b, { type: "theme", themeKind: "light" });
    expect(c.editInFlight).toBe(true);
    expect(c.theme).toBe("light");
  });

  it("theme action with same theme returns the same state reference", () => {
    const a = reducer(initialState, docAction({ docVersion: 1, themeKind: "dark" }));
    expect(a.theme).toBe("dark");
    const b = reducer(a, { type: "theme", themeKind: "dark" });
    expect(b).toBe(a);
  });

  it("carries an HC kind through to state.theme (host distinguishes HC from Light)", () => {
    const viaDoc = reducer(initialState, docAction({ docVersion: 1, themeKind: "hc-dark" }));
    expect(viaDoc.theme).toBe("hc-dark");
    const viaTheme = reducer(viaDoc, { type: "theme", themeKind: "hc-light" });
    expect(viaTheme.theme).toBe("hc-light");
  });
});

describe("reducer — save policy: serialize-error arm", () => {
  // A serialize result with ok: false (host reject / send failure) prevents
  // Edit posting and surfaces the error. C8 retired the parse/serialize
  // warning-consent arms; serialize-error is the only surviving save-policy gate.

  it("serialize-error surfaces the error and clears editInFlight", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "post-edit" });
    const c = reducer(b, { type: "serialize-error", error: serializeError });
    expect(c.serializeError).toEqual(serializeError);
    expect(c.editInFlight).toBe(false);
  });

  it("post-edit is dropped while a serialize-error is unresolved", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "serialize-error", error: serializeError });
    const c = reducer(b, { type: "post-edit" });
    expect(c.editInFlight).toBe(false);
    expect(c).toBe(b);
  });

  it("non-stale Document clears a prior serialize-error", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const b = reducer(a, { type: "serialize-error", error: serializeError });
    const c = reducer(b, docAction({ docVersion: 2 }));
    expect(c.serializeError).toBeNull();
  });
});

describe("canPostEdit — save-policy gate is the single source of truth", () => {
  // canPostEdit is the POLICY layer the reducer's post-edit case AND
  // edit-sync's canPost (via editor.ts) both consult, so the gate cannot
  // drift between them. These tests pin the contract that it encodes the
  // policy condition (serializeError) and DELIBERATELY excludes the two
  // mechanism gates (canWrite, editInFlight) — edit-sync enforces those
  // itself, and folding them in would make its readonly hard-drop
  // ambiguous. (C8 retired the parse/serialize warning-consent states, so
  // serializeError is the only surviving policy condition.)

  const stateWith = (overrides: Partial<WebviewState>): WebviewState => ({
    ...initialState,
    ready: true,
    canWrite: true,
    ...overrides,
  });

  it("permits posting when no serialize-error is pending", () => {
    expect(canPostEdit(stateWith({}))).toBe(true);
  });

  it("blocks posting while a serialize-error is unresolved", () => {
    expect(canPostEdit(stateWith({ serializeError }))).toBe(false);
  });

  it("ignores capability — readonly is a MECHANISM gate, not policy", () => {
    // canWrite=false must NOT make canPostEdit return false: edit-sync's
    // readOnly Compartment HARD-DROPS readonly changes before canPost is
    // consulted. If this predicate also gated on canWrite, a readonly
    // state would route through canPost's soft-buffer arm instead of the
    // drop — the exact ambiguity the contract forbids.
    expect(canPostEdit(stateWith({ canWrite: false }))).toBe(true);
  });

  it("ignores in-flight — single-flight is a MECHANISM gate, not policy", () => {
    // editInFlight is edit-sync's own single-flight tracker; canPostEdit
    // must not duplicate it.
    expect(canPostEdit(stateWith({ editInFlight: true }))).toBe(true);
  });

  it("agrees with the reducer's post-edit policy arm", () => {
    // The reducer drops a post-edit when canPostEdit is false (with
    // capability + in-flight clear). Pin that the two stay in lockstep.
    const seeded = reducer(initialState, docAction({ docVersion: 1 }));
    const withError = reducer(seeded, { type: "serialize-error", error: serializeError });
    expect(canPostEdit(withError)).toBe(false);
    const blocked = reducer(withError, { type: "post-edit" });
    expect(blocked).toBe(withError); // dropped — no editInFlight

    const cleared = reducer(withError, { type: "local-edit-attempt" });
    expect(canPostEdit(cleared)).toBe(true);
    const posted = reducer(cleared, { type: "post-edit" });
    expect(posted.editInFlight).toBe(true);
  });
});

describe("reducer — local-edit-attempt clears serializeError for retry", () => {
  // Path follow-up: after the host rejects an Edit, serializeError
  // is non-null and the post-edit gate is closed. The user typing another
  // character is their intent to retry — the next local-edit-attempt
  // clears serializeError so the debounced flush can ship a fresh Edit.

  it("clears a prior serialize-error", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const withError = reducer(a, { type: "serialize-error", error: serializeError });
    expect(withError.serializeError).toEqual(serializeError);
    const cleared = reducer(withError, { type: "local-edit-attempt" });
    expect(cleared.serializeError).toBeNull();
  });

  it("does not touch editInFlight", () => {
    // editInFlight was cleared by serialize-error; local-edit-attempt
    // does NOT re-arm it (the next post-edit dispatch does that).
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const withError = reducer(a, { type: "serialize-error", error: serializeError });
    const cleared = reducer(withError, { type: "local-edit-attempt" });
    expect(cleared.editInFlight).toBe(false);
  });

  it("post-edit unblocks after local-edit-attempt clears the error", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    const withError = reducer(a, { type: "serialize-error", error: serializeError });
    const cleared = reducer(withError, { type: "local-edit-attempt" });
    const posted = reducer(cleared, { type: "post-edit" });
    expect(posted.editInFlight).toBe(true);
  });

  it("is a no-op when serializeError is already null (returns same reference)", () => {
    // Avoid unnecessary re-renders: every keystroke must not spend a render
    // tick on a dispatch that has no effect. The shell relies on
    // referential identity to short-circuit dispatch / onReducerCommit.
    const seeded = reducer(initialState, docAction({ docVersion: 1 }));
    const result = reducer(seeded, { type: "local-edit-attempt" });
    expect(result).toBe(seeded);
  });
});

describe("reducer — purity", () => {
  // The reducer must be referentially transparent: same (state, action)
  // always returns the same next state. No reads from localStorage,
  // Date.now(), or acquireVsCodeApi() inside the reducer.

  it("returns deep-equal output for the same input on repeated calls", () => {
    const action = docAction({ docVersion: 3 });
    const a = reducer(initialState, action);
    const b = reducer(initialState, action);
    expect(b).toEqual(a);
  });

  it("does not mutate the input state object", () => {
    const snapshot = { ...initialState };
    reducer(initialState, docAction({ docVersion: 1 }));
    expect(initialState).toEqual(snapshot);
  });

  it("returned state matches the WebviewState shape", () => {
    const a = reducer(initialState, docAction({ docVersion: 1 }));
    // Pin the property set so additions / removals show up as test diffs.
    expect(Object.keys(a).sort()).toEqual(
      ["canWrite", "docVersion", "editInFlight", "ready", "serializeError", "theme"].sort()
    );
  });

  it("WebviewState is assignable from initialState", () => {
    const s: typeof initialState = initialState;
    expect(s).toBe(initialState);
  });
});
