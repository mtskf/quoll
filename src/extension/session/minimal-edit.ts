// Pure host-apply seam: the smallest single contiguous replacement that turns
// oldText into newText, via longest common prefix + suffix trim. Minimal for a
// single contiguous edit (typical typing); for a debounced flush that coalesces
// multiple disjoint edits it returns ONE span covering them (correct, coarser).
//
// Offsets are UTF-16 code units — the unit VS Code's TextDocument.positionAt /
// Range use — so the panel maps {from,to} to Positions with no re-encoding. No
// vscode import keeps this property-testable without a vscode runtime stub.
export type MinimalEditSpan = { from: number; to: number; insert: string };

export function minimalEditSpan(oldText: string, newText: string): MinimalEditSpan {
  const oldLen = oldText.length;
  const newLen = newText.length;
  const maxPrefix = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  // VS Code normalizes the EOL of each inserted edit independently, so a span
  // boundary that bisects a CRLF (lands between a \r and its following \n) would
  // isolate a lone \r/\n and round-trip differently from a whole-document
  // replace. This only happens when old and new disagree on EOL (mixed-EOL
  // buffers); the common-EOL path never splits a pair, so this snap is inert
  // for all reachable inputs — it makes minimal-span ≡ whole-doc-replace
  // unconditional. Snapping only WIDENS the span, so string equivalence
  // (old.slice(0,from) + insert + old.slice(to) === new) is preserved and
  // from > to can never arise.
  // 1. Snap the PREFIX boundary left while it bisects a CRLF in old or new.
  //    Prefix chars are common, so oldText[prefix-1] === newText[prefix-1].
  while (
    prefix > 0 &&
    oldText.charCodeAt(prefix - 1) === 13 &&
    (oldText.charCodeAt(prefix) === 10 || newText.charCodeAt(prefix) === 10)
  ) {
    prefix--;
  }
  // 2. Snap the SUFFIX boundary right while it bisects a CRLF in old or new.
  //    The kept \n is the common-suffix char oldText[oldLen-suffix]; the
  //    preceding \r sits in the replaced region of old and/or new.
  while (
    suffix > 0 &&
    oldText.charCodeAt(oldLen - suffix) === 10 &&
    (oldText.charCodeAt(oldLen - suffix - 1) === 13 ||
      newText.charCodeAt(newLen - suffix - 1) === 13)
  ) {
    suffix--;
  }
  return { from: prefix, to: oldLen - suffix, insert: newText.slice(prefix, newLen - suffix) };
}
