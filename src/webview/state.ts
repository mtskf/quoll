// Webview UI / protocol state reducer.
//
// Why a hand-rolled reducer (and not Jotai/Zustand/Redux): the state
// surface is tiny (~9 fields) and the transitions encode the protocol
// invariants (docVersion monotonicity, single-flight Edit, save-policy
// gating). Keeping the spec inside a ~150-line pure function means there
// is no third-party store to migrate when its maintainer disappears.
//
// Why content is NOT here: CodeMirror's EditorState owns the document
// body inside the webview (the CM EditorView mounted by editor.ts).
// Mirroring it in reducer state would require a sync invariant that
// fights for authority with EditorState. The reducer instead carries
// the small UI/protocol metadata that feeds the render.

import type { MarkdownError } from "../markdown/errors.js";
import type { ThemeKind } from "../shared/protocol.js";

export type WebviewState = {
  /** True once the webview has accepted at least one Document from the host. */
  ready: boolean;
  /** Last host-issued Document.docVersion. The webview never mints this — it
   *  echoes the value back as `baseDocVersion` on outgoing Edit messages so
   *  the host can detect stale-base edits with a single equality check. */
  docVersion: number;
  theme: ThemeKind;
  /** Host-authoritative write capability. When false, post-edit transitions
   *  are dropped at the reducer so read-only / virtual documents do not
   *  emit Edit messages the host would reject anyway. */
  canWrite: boolean;
  /** Single-flight invariant: at most one Edit pending at any time. Set
   *  true by a successful post-edit dispatch, cleared by the next non-stale
   *  Document (which is the host's authoritative acknowledgement). */
  editInFlight: boolean;
  /** Most recent send-side failure — dispatched when postMessage throws
   *  (closed MessagePort, structuredClone error, host throttle) during
   *  a post-edit call, or when the host rejects an Edit (`edit-rejected`).
   *  Blocks further post-edit transitions until cleared by the next
   *  non-stale Document or a local-edit-attempt retry. The sole surviving
   *  webview banner surface (C8 retired the PM-bridge parse-warning /
   *  parse-error machinery). */
  serializeError: MarkdownError | null;
};

export type Action =
  | {
      type: "document";
      docVersion: number;
      canWrite: boolean;
      themeKind: ThemeKind;
    }
  | { type: "theme"; themeKind: ThemeKind }
  | { type: "post-edit" }
  | { type: "serialize-error"; error: MarkdownError }
  | {
      /** Next user keystroke after a host-side rejected save attempt
       *  (serializeError != null). Clears the gate so the debounced
       *  flush can retry — the next post-edit dispatch will re-arm
       *  editInFlight and post a fresh Edit. The editor's docChanged
       *  handler ALSO calls sync.discardBuffer() before dispatching so
       *  the synchronous `onReducerCommit → replayIfNeeded` chain does
       *  not post stale pre-reject buffered bytes (see editor.ts and
       *  edit-sync.ts for the pair contract). No-op when serializeError
       *  is already null so per-keystroke dispatches are cheap. */
      type: "local-edit-attempt";
    };

export const initialState: WebviewState = {
  ready: false,
  docVersion: 0,
  theme: "dark",
  canWrite: false,
  editInFlight: false,
  serializeError: null,
};

/** Save-policy gate: does the current UI/protocol state PERMIT the webview
 *  to post an Edit to the host? This is the POLICY layer only — today the
 *  sole blocker is a pending host reject / send failure (`serializeError`),
 *  which holds until cleared. Any future warning/error state belongs here.
 *
 *  It deliberately does NOT encode the two MECHANISM gates the reducer's
 *  `post-edit` case also applies — write capability (`canWrite`) and the
 *  single-flight flag (`editInFlight`). Those are enforced independently by
 *  edit-sync: the readOnly Compartment HARD-DROPS readonly changes (so a
 *  readonly doc never buffers) and the single-flight tracker serialises
 *  in-flight Edits. Folding them in here would make edit-sync's readonly
 *  hard-drop AMBIGUOUS — a readonly state would route through `canPost()`'s
 *  soft-buffer arm (`cm/edit-sync.ts` `trySend`) instead of the `!canWrite`
 *  drop, and a held buffer could later replay content that was never
 *  legitimately editable.
 *
 *  SINGLE SOURCE OF TRUTH: consulted by both the reducer's `post-edit` case
 *  and edit-sync's `canPost` (wired through editor.ts). A new policy
 *  condition added here is honoured by both call sites, so the gate cannot
 *  drift between them. */
export function canPostEdit(state: WebviewState): boolean {
  return state.serializeError === null;
}

export function reducer(state: WebviewState, action: Action): WebviewState {
  switch (action.type) {
    case "document": {
      // Two-comparison rule: the webview accepts a Document iff
      // incoming >= displayed. The host uses === on Edit base versions;
      // the two comparisons answer different questions and stay inlined
      // at their call sites.
      if (action.docVersion < state.docVersion) {
        return state;
      }
      return {
        ready: true,
        docVersion: action.docVersion,
        theme: action.themeKind,
        canWrite: action.canWrite,
        editInFlight: false,
        // A fresh non-stale Document clears a prior host reject so the user
        // can resume editing (existing behavior; kept after the warning-
        // field pruning).
        serializeError: null,
      };
    }
    case "theme": {
      const next = action.themeKind;
      if (state.theme === next) {
        return state;
      }
      return { ...state, theme: next };
    }
    case "post-edit": {
      // Single-flight + save-policy gate: capability (mechanism) first,
      // then in-flight (mechanism), then the shared save-policy arm. The
      // policy arm is hoisted to canPostEdit() so edit-sync's canPost
      // consults the SAME predicate and the two cannot drift. The two
      // mechanism arms stay inline (NOT in canPostEdit) so edit-sync's
      // readonly hard-drop / single-flight semantics keep their own
      // authority — see the canPostEdit contract. (C8 removed the
      // parse/serialize warning-consent arms — serializeError is the only
      // surviving policy condition.)
      if (!state.canWrite) {
        return state;
      }
      if (state.editInFlight) {
        return state;
      }
      if (!canPostEdit(state)) {
        return state;
      }
      return { ...state, editInFlight: true };
    }
    case "serialize-error": {
      return { ...state, serializeError: action.error, editInFlight: false };
    }
    case "local-edit-attempt": {
      if (state.serializeError === null) {
        return state;
      }
      return { ...state, serializeError: null };
    }
    default: {
      // Exhaustiveness guard — a new Action variant added without a case here
      // makes this assignment fail to compile (`action` is not `never`). The
      // arm is unreachable at runtime: `Action` is a closed internal union and
      // every dispatch site is typed. If a refactor ever violates that, THROW
      // (do not `return`) — this is the same failure mode shell.ts's HostToWebview
      // guard and every host-side closed-union switch use (quoll-editor-panel,
      // effect-executor, host-session-core all `throw "[quoll] unhandled …"`),
      // so the pair fails loud identically. The old `return _exhaustive` was the
      // lone outlier and, worse, returned the unknown ACTION object as the new
      // state (corrupting it); failing loud on an impossible state is safer and
      // consistent. shell.ts's dispatch already treats a reducer throw as a
      // precondition break it must NOT swallow.
      const _exhaustive: never = action;
      throw new Error(`[quoll] unhandled Action: ${(_exhaustive as { type: string }).type}`);
    }
  }
}
