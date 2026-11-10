// Test-side readers for a structural block field's record set
// (src/webview/cm/structural-blocks.ts). Production reads payloads only through
// `recordAt`; tests that compare whole record lists or widgets go through these.
import type { WidgetType } from "@codemirror/view";
import type { BuiltBlock, StructuralRecordSet } from "../../../src/webview/cm/structural-blocks.js";

/** Every record of the set as `{ from, to, block }`, in document order. */
export function recordsOf<B>(set: StructuralRecordSet<B>): BuiltBlock<B>[] {
  const out: BuiltBlock<B>[] = [];
  for (const it = set.iter(); it.value !== null; it.next()) {
    out.push({ from: it.from, to: it.to, block: it.value.spec.structural as B });
  }
  return out;
}

/** The widget of every record of the set, in document order. */
export function recordWidgetsOf<B>(set: StructuralRecordSet<B>): WidgetType[] {
  const out: WidgetType[] = [];
  for (const it = set.iter(); it.value !== null; it.next()) {
    out.push(it.value.spec.widget as WidgetType);
  }
  return out;
}
