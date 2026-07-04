import { describe, expect, it } from "vitest";

import {
  decideRevealInvariant,
  planRevealTabClose,
  type RevealCleanupGroup,
} from "../../src/extension/reveal-for-mention-cleanup.js";

// Opaque tab handles — the planner never inspects them, only routes them.
type Tab = { id: string };
const tab = (id: string): Tab => ({ id });

const group = (
  viewColumn: number,
  docTextTabs: Tab[],
  docCustomTab: { isActive: boolean } | null = null
): RevealCleanupGroup<Tab> => ({ viewColumn, docTextTabs, docCustomTab });

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
  it("ok when the custom tab is the active tab of its group", () => {
    const decision = decideRevealInvariant([group(1, [], { isActive: true })]);
    expect(decision).toEqual({ kind: "ok" });
  });

  it("enforce (with the custom tab's viewColumn) when it exists but is not active — the reuse class", () => {
    // The H2 shape: the reused text tab is active in front of the custom tab.
    const decision = decideRevealInvariant([group(1, [tab("users-own")], { isActive: false })]);
    expect(decision).toEqual({ kind: "enforce", viewColumn: 1 });
  });

  it("enforce targets the group holding the custom tab, not other groups", () => {
    const decision = decideRevealInvariant([
      group(1, [tab("text-g1")]),
      group(2, [], { isActive: false }),
    ]);
    expect(decision).toEqual({ kind: "enforce", viewColumn: 2 });
  });

  it("no-custom-tab when the Quoll tab is gone (closed mid-handoff)", () => {
    const decision = decideRevealInvariant([group(1, [tab("text-g1")])]);
    expect(decision).toEqual({ kind: "no-custom-tab" });
  });

  it("ok when ANY custom tab is active (defensive duplicate handling)", () => {
    const decision = decideRevealInvariant([
      group(1, [], { isActive: false }),
      group(2, [], { isActive: true }),
    ]);
    expect(decision).toEqual({ kind: "ok" });
  });
});
