import { describe, expect, it } from "vitest";

import {
  decideRevealInvariant,
  planRevealTabClose,
  type RevealCleanupGroup,
} from "../../src/extension/handoff/reveal-for-mention-cleanup.js";

// Opaque tab handles — the planner never inspects them, only routes them.
type Tab = { id: string };
const tab = (id: string): Tab => ({ id });

const group = (
  viewColumn: number,
  docTextTabs: Tab[],
  docCustomTab: { isActive: boolean } | null = null,
  isActiveGroup = false
): RevealCleanupGroup<Tab> => ({ viewColumn, docTextTabs, docCustomTab, isActiveGroup });

describe("planRevealTabClose (phase a — delta computation)", () => {
  it("closes a text tab the reveal opened in a group with no pre-existing one", () => {
    const opened = tab("reveal-opened");
    const result = planRevealTabClose(new Set(), [group(1, [opened], { isActive: false })]);
    expect(result).toEqual([opened]);
  });

  it("closes nothing when the group already held a text tab pre-reveal (reuse — the user's own tab)", () => {
    const preExisting = tab("users-own");
    const result = planRevealTabClose(new Set([1]), [group(1, [preExisting], { isActive: false })]);
    expect(result).toEqual([]);
  });

  it("closes only the delta across mixed groups", () => {
    const preExisting = tab("users-own-g1");
    const opened = tab("reveal-opened-g2");
    const result = planRevealTabClose(new Set([1]), [
      group(1, [preExisting], { isActive: true }),
      group(2, [opened]),
    ]);
    expect(result).toEqual([opened]);
  });

  it("returns empty when no text tab for the doc exists anywhere", () => {
    const result = planRevealTabClose(new Set(), [group(1, [], { isActive: true }), group(2, [])]);
    expect(result).toEqual([]);
  });

  it("ignores the snapshot for groups that no longer exist and still closes new-group tabs", () => {
    // Snapshot recorded group 3, which has since closed; the reveal-opened
    // tab in group 2 must still be identified as delta.
    const opened = tab("reveal-opened-g2");
    const result = planRevealTabClose(new Set([3]), [group(2, [opened])]);
    expect(result).toEqual([opened]);
  });
});

describe("decideRevealInvariant (phase b — cleanup contract verdict)", () => {
  it("ok when the custom tab is active AND its group is the active group", () => {
    const decision = decideRevealInvariant([group(1, [], { isActive: true }, true)]);
    expect(decision).toEqual({ kind: "ok" });
  });

  it("enforce (with the custom tab's viewColumn) when it exists but is not active in its group — the reuse class", () => {
    // The H2 shape: the reused text tab is active in front of the custom tab.
    const decision = decideRevealInvariant([
      group(1, [tab("users-own")], { isActive: false }, true),
    ]);
    expect(decision).toEqual({ kind: "enforce", viewColumn: 1 });
  });

  it("enforce (with the custom group's viewColumn) when the custom tab is active in-group but a DIFFERENT group is the active group", () => {
    // Finding 2: Quoll custom tab active WITHIN group 1, but the ACTIVE group is
    // group 2 (a pre-existing text editor of the same doc). The in-group
    // isActive flag alone would wrongly report ok; requiring isActiveGroup
    // catches that focus sits on the raw text editor and enforces a re-reveal of
    // Quoll's group so it becomes the active group again.
    const decision = decideRevealInvariant([
      group(1, [], { isActive: true }, false),
      group(2, [tab("text-g2")], null, true),
    ]);
    expect(decision).toEqual({ kind: "enforce", viewColumn: 1 });
  });

  it("enforce targets the group holding the custom tab, not other groups", () => {
    const decision = decideRevealInvariant([
      group(1, [tab("text-g1")], null, true),
      group(2, [], { isActive: false }, false),
    ]);
    expect(decision).toEqual({ kind: "enforce", viewColumn: 2 });
  });

  it("no-custom-tab when the Quoll tab is gone (closed mid-handoff)", () => {
    const decision = decideRevealInvariant([group(1, [tab("text-g1")], null, true)]);
    expect(decision).toEqual({ kind: "no-custom-tab" });
  });

  it("ok when ANY custom tab is active in its active group (defensive duplicate handling)", () => {
    const decision = decideRevealInvariant([
      group(1, [], { isActive: false }, false),
      group(2, [], { isActive: true }, true),
    ]);
    expect(decision).toEqual({ kind: "ok" });
  });
});
