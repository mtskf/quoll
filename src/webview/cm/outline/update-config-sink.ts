// Injected webview→host sink for update-config, mirroring quollOpenExternalSink.
// The settings popover lives inside a ViewPlugin and cannot be dependency-
// injected at construction, so it reads this facet at click time. The editor
// provides updateConfigSinkFor(getHost()); tests provide a spy. Posts go through
// safePostMessage (never a bare getHost().postMessage from cm/).

import { Facet } from "@codemirror/state";
import { type EditorPrefKey, PROTOCOL_VERSION, type WebviewToHost } from "../../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../../safe-post-message.js";

export type UpdateConfigSink = (key: EditorPrefKey, value: string) => void;

/** Facet carrying the update-config poster. combine returns the LAST provider
 *  (single provider in production), defaulting to a no-op — byte-identical to
 *  quollOpenExternalSink's combine (open-external.ts) so "mirrors
 *  open-external" is literally true. */
export const quollUpdateConfigSink = Facet.define<UpdateConfigSink, UpdateConfigSink>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : () => {}),
});

/** Build a sink that posts an update-config to `host` via safePostMessage. */
export function updateConfigSinkFor(host: PostMessageHost): UpdateConfigSink {
  return (key, value) => {
    const message: WebviewToHost = { protocol: PROTOCOL_VERSION, type: "update-config", key, value };
    safePostMessage(host, message, "update-config");
  };
}
