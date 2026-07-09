// Non-vacuity pins for scripts/check-todo-hygiene.mjs.
//
// The linter enforces the four TODO.md entry conventions (Done-when /
// 🚧 branch / gated-on / non-checkbox-bullet). These tests feed the PURE rule
// functions in-memory fixture strings — one planted violation per rule — and
// assert each is caught, plus positive controls proving the rules don't
// over-fire (grandfathered sections, resolvable gates, history bullets).
//
// Why in-memory (never the real .claude/docs/TODO.md): that file is
// git-ignored and absent from CI checkouts, so reading it here would fail in
// CI. "Passes on current main" is pinned separately by the local
// `pnpm check:todo-hygiene` run, not by this suite.
//
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs
// this transpile-only and tsc does not include test/build/ in `pnpm compile`.
import { describe, expect, it } from "vitest";

import {
  lintBranchMarker,
  lintDoneWhen,
  lintGatedRefs,
  lintNonCheckboxBullets,
  lintTodoText,
  normalizeHeading,
} from "../../scripts/check-todo-hygiene.mjs";

// A fully convention-compliant document that must lint clean.
const CLEAN = `# TODO

## ▶️ Active queue

### 🐛 Bugs

- [ ] 🐛 [HIGH] **Fix the widget** — gated on the render pipeline entry above.
  - Done when: the widget is fixed; \`pnpm test:unit\` green.
- [ ] 🚧 🐛 [LOW] **Ship the render pipeline** (branch: feat/pipeline)
  - Done when: pipeline shipped.
- [x] 🐛 [LOW] **Already done, no Done-when needed**

### 🧭 Editor UX / customization

- [ ] 🧭 [LOW] **Legacy idea predating the convention**
  - just a note — grandfathered section, no Done when required.

## 🗂 Deferred decisions

- A parked decision, deliberately not a checkbox bullet.
`;

describe("todo-hygiene linter — clean baseline", () => {
  it("reports no violations on a compliant document", () => {
    expect(lintTodoText(CLEAN)).toEqual([]);
  });
});

describe("rule 1 — Done-when", () => {
  it("catches an active entry with no Done-when sub-bullet in an enforced section", () => {
    const doc = `## Active

### 🐛 Bugs

- [ ] 🐛 [MED] **Missing acceptance criteria**
  - some prose but no acceptance line.
`;
    const v = lintDoneWhen(doc);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe(1);
    expect(v[0].line).toBe(5);
  });

  it("accepts the parenthetical `Done when (…):` variant", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Gated build**
  - Done when (only if the profiling gate opens): it is fast.
`;
    expect(lintDoneWhen(doc)).toEqual([]);
  });

  it("exempts entries under a grandfathered heading", () => {
    const doc = `### 🧭 Editor UX / customization

- [ ] 🧭 [LOW] **Legacy backlog idea**
  - no Done when, and that is allowed here.
`;
    expect(lintDoneWhen(doc)).toEqual([]);
  });

  it("skips checked (done) entries", () => {
    const doc = `### 🐛 Bugs

- [x] 🐛 [LOW] **Shipped without a Done-when bullet**
`;
    expect(lintDoneWhen(doc)).toEqual([]);
  });
});

describe("rule 2 — branch marker", () => {
  it("catches a 🚧 entry that names no branch", () => {
    const doc = `### 🐛 Bugs

- [ ] 🚧 🐛 [LOW] **In flight, no branch named**
  - Done when: shipped.
`;
    const v = lintBranchMarker(doc);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe(2);
    expect(v[0].line).toBe(3);
  });

  it("accepts the modern (branch: …) form", () => {
    const doc = `### 🐛 Bugs

- [ ] 🚧 🐛 [LOW] **In flight** (branch: fix/foo)
  - Done when: shipped.
`;
    expect(lintBranchMarker(doc)).toEqual([]);
  });

  it("accepts the legacy <!-- branch: … --> form", () => {
    const doc = `### 🐛 Bugs

- [ ] 🚧 🐛 [LOW] **In flight** <!-- branch: fix/foo -->
  - Done when: shipped.
`;
    expect(lintBranchMarker(doc)).toEqual([]);
  });
});

describe("rule 3 — gated-on reference resolution", () => {
  it("catches a gated-on reference that resolves to nothing", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Downstream work** — gated on the phantom entry above.
  - Done when: done.
`;
    const v = lintGatedRefs(doc);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe(3);
    expect(v[0].line).toBe(3);
  });

  it("resolves a reference to another entry title", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Downstream** — gated on the upstream fix entry above.
  - Done when: done.
- [ ] 🐛 [LOW] **The upstream fix**
  - Done when: done.
`;
    expect(lintGatedRefs(doc)).toEqual([]);
  });

  it("ignores a matching phrase inside inline code (the rule's own docs)", () => {
    // The backticked phrase WOULD match the regex (it has the `entry` trigger
    // and resolves to nothing), so this genuinely exercises stripInlineCode:
    // backticked → suppressed, un-backticked → a violation (asserted next).
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Meta** — enforce that \`gated on the phantom entry\` is inert.
  - Done when: done.
`;
    expect(lintGatedRefs(doc)).toEqual([]);
  });

  it("does flag the same phrase once the backticks are removed (non-vacuity control)", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Meta** — enforce that gated on the phantom entry is inert.
  - Done when: done.
`;
    expect(lintGatedRefs(doc)).toHaveLength(1);
  });

  it("emits one violation per unresolved reference on a single line", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Two gates** — gated on the alpha entry and gated on the beta entry.
  - Done when: done.
`;
    expect(lintGatedRefs(doc)).toHaveLength(2);
  });
});

describe("rule 4 — non-checkbox bullets", () => {
  it("catches a top-level non-checkbox bullet under an active section", () => {
    const doc = `### 🐛 Bugs

- A stray note that is not a checkbox.
`;
    const v = lintNonCheckboxBullets(doc);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe(4);
    expect(v[0].line).toBe(3);
  });

  it("allows non-checkbox bullets under a history/decisions section", () => {
    const doc = `## 🗂 Deferred decisions

- A parked decision, deliberately not a checkbox.
`;
    expect(lintNonCheckboxBullets(doc)).toEqual([]);
  });

  it("does not flag real checkboxes", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **A real task**
  - Done when: done.
`;
    expect(lintNonCheckboxBullets(doc)).toEqual([]);
  });
});

describe("fenced-code safety", () => {
  it("does not treat checkbox lines inside a fenced example as entries", () => {
    const doc = `### 🐛 Bugs

- [ ] 🐛 [LOW] **Documents a smoke test** (branch: n/a is fine here)
  - Done when: done.

  \`\`\`\`markdown
  - [ ] open task
  - [x] done task
  - Done when: this is inside a fence and must be ignored
  \`\`\`js
  const x = 1;
  \`\`\`
  \`\`\`\`
`;
    // The fenced `- [ ]` lines must not surface as rule-1/rule-2 violations,
    // and the fenced `- ` bullets must not surface as rule-4 violations.
    expect(lintTodoText(doc)).toEqual([]);
  });
});

describe("CRLF safety", () => {
  it("still detects violations when the document uses CRLF line endings", () => {
    // A stray trailing \r must not silently disable the $-anchored regexes.
    const doc = [
      "### 🐛 Bugs",
      "",
      "- [ ] 🐛 [MED] **CRLF task with no Done-when**",
      "  - just prose.",
      "",
    ].join("\r\n");
    const v = lintDoneWhen(doc);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe(1);
  });
});

describe("combined planted violations — one per rule", () => {
  it("catches all four rules in a single document", () => {
    const doc = `## ▶️ Active queue

### 🐛 Bugs

- [ ] 🐛 [MED] **No acceptance criteria here**
  - just prose.
- [ ] 🚧 🐛 [LOW] **In flight without a branch**
  - Done when: shipped.
- [ ] 🐛 [LOW] **Dangling gate** — gated on the vanished entry above.
  - Done when: done.
- A stray non-checkbox bullet under an active section.
`;
    const rules = lintTodoText(doc)
      .map((v) => v.rule)
      .sort();
    expect(rules).toContain(1);
    expect(rules).toContain(2);
    expect(rules).toContain(3);
    expect(rules).toContain(4);
  });
});

describe("normalizeHeading", () => {
  it("strips emoji and punctuation to a lowercase word run", () => {
    expect(normalizeHeading("🧭 Editor UX / customization")).toBe("editor ux customization");
    expect(normalizeHeading("🗂 Deferred decisions")).toBe("deferred decisions");
  });
});
