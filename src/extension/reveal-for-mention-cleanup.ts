// Pure cleanup planner for QuollEditorPanel's revealForMention (the ⌘⌥K
// Claude Code handoff, tier 0).
//
// The cleanup CONTRACT: after cleanup, the Quoll custom tab for the document
// is the ACTIVE tab of its group again. A snapshot-only cleanup ("close text
// tabs in groups that did not hold one pre-reveal") cannot deliver that
// contract by itself — when the reveal REUSES a pre-existing background text
// tab in the custom tab's own group (the tab is not in visibleTextEditors, so
// the reveal targets ViewColumn.Active and VS Code activates the existing tab
// instead of opening a new one), there is nothing to close and the pane stays
// switched to the raw text editor. Pinned by
// test/extension/e2e/context-handoff-reveal-cleanup.test.ts.
//
// So the cleanup is two-phase:
//   (a) planRevealTabClose — the DELTA text tabs to close: tabs for the
//       document that were NOT present pre-reveal, compared per group. On a
//       reuse there is no delta and nothing is closed, so the user's own
//       pre-existing tab is never touched.
//   (b) decideRevealInvariant — verify the contract over the post-close
//       inventory; when it failed (reuse, close failure, any other class)
//       the host ENFORCES it by re-revealing the existing custom editor.
//
// vscode-import-free and generic over the host's Tab handle so the delta
// computation and the invariant decision unit-test without a live host
// (mirrors handle-context-handoff.ts's injected-deps posture).

/** One tab group's view of the tabs relevant to the reveal cleanup. Groups
 *  are keyed by `viewColumn` — the stable per-group key (Tab / TabGroup
 *  object identity is not stable across tab-model events). `T` is the host's
 *  opaque tab handle (vscode.Tab in production), carried through so the
 *  planner's output can be handed straight to `tabGroups.close`. */
export type RevealCleanupGroup<T> = {
  viewColumn: number;
  /** Whether THIS group is the ACTIVE tab group (vscode.TabGroup.isActive).
   *  Load-bearing for the contract: a custom tab that is active WITHIN its
   *  group does not satisfy the contract when a DIFFERENT group holds focus
   *  (e.g. a pre-existing text editor of the same doc in a separate group —
   *  the reveal focuses that group, but the custom tab's own in-group isActive
   *  flag stays true). Only the active-group check catches that case. */
  isActiveGroup: boolean;
  /** Text tabs (TabInputText) for THIS document in this group. */
  docTextTabs: readonly T[];
  /** The Quoll custom tab (TabInputCustom, quoll.editMarkdown) for THIS
   *  document in this group with its in-group activation state, or null when
   *  the group has none. At most one exists host-wide
   *  (supportsMultipleEditorsPerDocument: false), but the planner stays
   *  defensive about duplicates. */
  docCustomTab: { readonly isActive: boolean } | null;
};

/** Phase (a): the DELTA text tabs to close — text tabs of the document in
 *  groups that did NOT already hold one before the reveal. When the reveal
 *  reused a pre-existing tab, its group is in the snapshot, so there is no
 *  delta and the user's own tab is never closed. */
export function planRevealTabClose<T>(
  groupsWithDocBefore: ReadonlySet<number>,
  groups: readonly RevealCleanupGroup<T>[]
): T[] {
  const toClose: T[] = [];
  for (const group of groups) {
    if (groupsWithDocBefore.has(group.viewColumn)) {
      continue;
    }
    toClose.push(...group.docTextTabs);
  }
  return toClose;
}

/** Phase (b) verdict over a post-close inventory. */
export type RevealInvariantDecision =
  /** The contract holds — the custom tab is the active tab of the ACTIVE
   *  group. */
  | { kind: "ok" }
  /** The custom tab exists but is NOT the active tab of the active group
   *  (reuse case, close failure, or focus left on another group) — enforce by
   *  re-revealing it in `viewColumn`, which re-focuses that group too. */
  | { kind: "enforce"; viewColumn: number }
  /** No custom tab exists anywhere (e.g. the user closed the Quoll tab while
   *  the handoff was in flight) — nothing to enforce. */
  | { kind: "no-custom-tab" };

/** Phase (b): decide whether the cleanup contract holds. The contract needs
 *  BOTH that the custom tab is active WITHIN its group AND that its group is
 *  the ACTIVE group — an in-group-active custom tab whose group does NOT hold
 *  focus (the reveal landed on a same-doc text editor in another group) leaves
 *  the user in the raw text editor, so it must enforce. Defensive about a
 *  duplicate custom tab (should be impossible): ANY custom tab satisfying both
 *  conditions is ok; otherwise the first custom tab found is the enforcement
 *  target (re-revealing it re-focuses Quoll's group). */
export function decideRevealInvariant(
  groups: readonly RevealCleanupGroup<unknown>[]
): RevealInvariantDecision {
  let enforceColumn: number | null = null;
  for (const group of groups) {
    if (group.docCustomTab === null) {
      continue;
    }
    if (group.docCustomTab.isActive && group.isActiveGroup) {
      return { kind: "ok" };
    }
    if (enforceColumn === null) {
      enforceColumn = group.viewColumn;
    }
  }
  return enforceColumn === null
    ? { kind: "no-custom-tab" }
    : { kind: "enforce", viewColumn: enforceColumn };
}
