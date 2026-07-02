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
import type { WebviewState } from "./state.js";

/** Small UI/protocol metadata persisted across reloads via vscode.setState.
 *  Defined as a Pick<> of WebviewState so the persisted-shape stays a
 *  type-checked subset of reducer state — a future widening of `theme` or
 *  rename of `canWrite` propagates here automatically, and adding a field
 *  to this list without adding it to WebviewState fails to compile.
 *  Never includes `content`: full document text lives in CodeMirror's
 *  EditorState and is reseeded by the next host Document on reload. */
export type PersistedMetadata = Pick<WebviewState, "ready" | "docVersion" | "canWrite" | "theme">;

export type Host = {
  postMessage(message: WebviewToHost): void;
  setMetadata(metadata: PersistedMetadata): void;
};

let memo: Host | null = null;
let acquireFailed: Error | null = null;

export function getHost(): Host {
  if (memo) {
    return memo;
  }
  // Cache the failure: every caller (shell mount, editor post, retry) must
  // see the same error rather than re-throwing a fresh ReferenceError.
  // Without this cache the init-error catch in index.ts would see a
  // different Error identity per call and could thrash the banner.
  if (acquireFailed) {
    throw acquireFailed;
  }
  if (typeof acquireVsCodeApi !== "function") {
    acquireFailed = new Error(
      "Quoll webview: acquireVsCodeApi is not defined. This build must run inside a VS Code webview host."
    );
    throw acquireFailed;
  }
  try {
    const api: WebviewApi<PersistedMetadata> = acquireVsCodeApi();
    memo = {
      postMessage: (message) => {
        api.postMessage(message);
      },
      setMetadata: (metadata) => {
        api.setState(metadata);
      },
    };
    return memo;
  } catch (err) {
    acquireFailed = err instanceof Error ? err : new Error(String(err));
    throw acquireFailed;
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
        console.error("[quoll] host message rejected by validator", event.data);
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
