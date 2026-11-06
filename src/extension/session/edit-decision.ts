// Pure host-side decision for an inbound webview Edit.
// Capability, current base and EOL-insensitive no-op checks precede acceptance.

import { sameTextIgnoringEol } from "../../shared/text-equality.js";

export type EditVerdict =
  | { kind: "accept" }
  | { kind: "no-op" }
  | { kind: "stale" }
  | { kind: "readonly" };

export type DecideEditInput = {
  baseIsCurrent: boolean;
  canWrite: boolean;
  content: string;
  currentContent: string;
};

export function decideEdit(input: DecideEditInput): EditVerdict {
  if (!input.canWrite) {
    return { kind: "readonly" };
  }
  if (!input.baseIsCurrent) {
    return { kind: "stale" };
  }
  if (sameTextIgnoringEol(input.content, input.currentContent)) {
    return { kind: "no-op" };
  }
  return { kind: "accept" };
}
