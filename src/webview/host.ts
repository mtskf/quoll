// Typed wrapper over the VS Code webview API.
//
// Why a singleton: `acquireVsCodeApi` is callable exactly once per webview
// instance — a second call throws. We memoize so any caller (shell, editor,
// tests-via-mock) can ask for the handle without coordinating order.
//
// Why validate before dispatch: the webview's window receives every
// postMessage on its frame, including any sender that can reach it. The
// Slice 1 validators are the only thing that proves an incoming message is
// shaped like our protocol before it touches the reducer or the editor.

import type { WebviewApi } from "vscode-webview";

import {
  type HostToWebview,
  isHostToWebview,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../shared/protocol.js";

export type Host = {
  postMessage(message: WebviewToHost): void;
};

let rawApi: WebviewApi<Record<string, unknown>> | null = null;
let memo: Host | null = null;
let acquireFailed: Error | null = null;

/** Acquire (once) the VS Code webview handle, throwing on failure — the
 *  contract getHost() relies on. Memoizes both the raw api and the failure.
 *  `acquireFailed` is checked BEFORE `rawApi`: a hard failure is terminal, so a
 *  soft acquire that later populates `rawApi` can NOT silently un-fail
 *  getHost() — the "same Error identity forever" anti-banner-thrash contract
 *  (see index.ts's init-error catch) is preserved. */
function acquireRawApiOrThrow(): WebviewApi<Record<string, unknown>> {
  if (acquireFailed) {
    throw acquireFailed;
  }
  if (rawApi) {
    return rawApi;
  }
  if (typeof acquireVsCodeApi !== "function") {
    acquireFailed = new Error(
      "Quoll webview: acquireVsCodeApi is not defined. This build must run inside a VS Code webview host."
    );
    throw acquireFailed;
  }
  try {
    rawApi = acquireVsCodeApi() as WebviewApi<Record<string, unknown>>;
    return rawApi;
  } catch (err) {
    acquireFailed = err instanceof Error ? err : new Error(String(err));
    throw acquireFailed;
  }
}

/** Soft acquire: the raw handle, or null when unavailable — for persistence
 *  that must degrade to a no-op outside a webview (unit tests, preview). This
 *  path MUST NOT write `acquireFailed` — poisoning that cache would make a
 *  LATER getHost() (once the API appears) keep throwing the stale "not
 *  defined". And it bails on an already-cached hard failure so it can't
 *  resurrect a terminated getHost(). */
function tryRawApi(): WebviewApi<Record<string, unknown>> | null {
  if (rawApi) {
    return rawApi;
  }
  if (acquireFailed) {
    return null; // hard failure is terminal — soft path must not resurrect it
  }
  if (typeof acquireVsCodeApi !== "function") {
    return null; // no cache write — soft path
  }
  try {
    rawApi = acquireVsCodeApi() as WebviewApi<Record<string, unknown>>;
    return rawApi;
  } catch {
    return null; // no cache write — soft path
  }
}

export function getHost(): Host {
  if (memo) {
    return memo;
  }
  const api = acquireRawApiOrThrow();
  memo = {
    postMessage: (message) => {
      api.postMessage(message);
    },
  };
  return memo;
}

/** The webview-local persisted view state (survives reload / hidden). Returns
 *  {} when unavailable OR on any error. This is where webview UI view state
 *  lives — a flat plain-object bag; callers own their own keys (contract:
 *  plain objects only, no arrays/other shapes). Never throws (the host's
 *  getState may itself throw). */
export function readPersistedState(): Record<string, unknown> {
  try {
    const api = tryRawApi();
    const state = api?.getState();
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/** Shallow-merge a patch into the persisted view state. No-op when the API is
 *  unavailable. Never throws — persistence failure must not break the UI; a
 *  lost width preference is strictly better than a crashed drag-end. */
export function patchPersistedState(patch: Record<string, unknown>): void {
  try {
    const api = tryRawApi();
    if (!api) {
      return;
    }
    const current = api.getState();
    const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    api.setState({ ...base, ...patch });
  } catch {
    // swallow: UI preference persistence is best-effort
  }
}

/** Subscribe to validated host→webview messages. Handlers only see
 *  payloads that pass `isHostToWebview`; everything else is logged at the
 *  boundary so neither the reducer nor the editor sees malformed input.
 *  Returns an unsubscribe function.
 *
 *  Why log on reject (not silent drop): a silent drop would let a host
 *  bug or protocol drift (`protocol: 2` from a future host) freeze the
 *  webview with no diagnostic — the user sees a stale document and no
 *  console trail. Logging at this boundary gives triage a single
 *  greppable line ("[quoll] host message rejected"). */
export function subscribeToHost(handler: (message: HostToWebview) => void): () => void {
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isHostToWebview(event.data)) {
      const data = event.data as { protocol?: unknown; type?: unknown } | null;
      // An absent payload (a real `window.postMessage(undefined)`) is not a
      // malformed message — logging it as "rejected by validator" misdirects
      // triage toward a protocol-shape bug. Branch on it first.
      if (event.data === undefined) {
        console.error("[quoll] host message rejected: empty payload (undefined data)");
      } else if (
        data !== null &&
        typeof data === "object" &&
        "protocol" in data &&
        data.protocol !== PROTOCOL_VERSION
      ) {
        console.error("[quoll] host message rejected: protocol mismatch", {
          expected: PROTOCOL_VERSION,
          got: data.protocol,
          type: data.type,
        });
      } else {
        // Symmetric with the host-side inbound-validation log (quoll-editor-panel.ts):
        // preview only type + top-level keys, never the full payload, so an
        // unvalidated message can't leak arbitrary content to the console.
        const preview =
          data !== null && typeof data === "object"
            ? { type: data.type, keys: Object.keys(data) }
            : { type: typeof event.data };
        console.error("[quoll] host message rejected by validator", preview);
      }
      return;
    }
    handler(event.data);
  };
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
  };
}
