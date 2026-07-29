// Non-vacuity pins for scripts/check-stale-todo-markers.mjs.
//
// The script is the backstop that catches stale in-flight (🚧) TODO markers
// whose PR merged outside /merge-pr. It shells out to `gh`. These tests feed
// the PURE / dependency-injected exports in-memory fixtures — a fake `ghRunner`
// (and a fake `exec` for `ghExec`) — so no real `gh` binary, network, or auth
// is needed, and the three historical false-verdict paths stay pinned:
//   (a) a REUSED head-branch name whose OLD PR merged must not flag still-open
//       work as stale — an OPEN PR for the branch wins.
//   (b) a bare `(#N)` / number-only match must downgrade to a WARNING, never a
//       hard STALE verdict (PR numbers are reused across repo generations).
//   (c) one transient gh failure must skip only THAT entry and keep scanning —
//       not bail the whole loop — and the exit must reflect a partial scan.
//
// Why in-memory (never the real .claude/docs/TODO.md): that file is git-ignored
// and absent from CI checkouts, so reading it here would fail in CI — same rule
// as test/build/todo-hygiene.test.ts.
//
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs this
// transpile-only and tsc does not include test/build/ in `pnpm compile`.
import { describe, expect, it } from "vitest";

import {
  classifyGhError,
  GhTransient,
  GhUnavailable,
  ghExec,
  parseEntry,
  resolveEntry,
  runScan,
  scanTodo,
  summarize,
} from "../../scripts/check-stale-todo-markers.mjs";

// A fake `ghRunner`, keyed on the argv array. `resolveEntry` issues the branch
// lookup as two independent `--state`-scoped queries (open, then merged), so
// `routes.list[headBranch]` is itself keyed by state: `{ open: [...], merged:
// [...] }`. `routes.view[prNumber]` keeps its single form. Any leaf may be a
// canned value or a 0-arg function (a function lets a route throw
// GhTransient/GhUnavailable/TypeError to simulate failures).
function makeGh(routes = {}) {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      const head = args[args.indexOf("--head") + 1];
      const state = args[args.indexOf("--state") + 1];
      const r = routes.list?.[head]?.[state];
      return typeof r === "function" ? r() : (r ?? []);
    }
    if (args[0] === "pr" && args[1] === "view") {
      const r = routes.view?.[args[2]];
      return typeof r === "function" ? r() : (r ?? { state: "OPEN" });
    }
    return [];
  };
}

// A one-entry / two-entry in-flight TODO fixture. Each entry carries the 🚧
// glyph, a `(branch: X)` (or `(#N)`) marker, and a **bold** title.
function todo(...entries) {
  return ["# TODO", "", "## ▶️ Active queue", "", ...entries, ""].join("\n");
}
const branchEntry = (branch, title) =>
  `- [ ] 🚧 🐛 [MED] **${title}** (branch: ${branch})\n  - Done when: shipped.`;
const numberEntry = (n, title) => `- [ ] 🚧 🐛 [MED] **${title}** (#${n})\n  - Done when: shipped.`;

describe("resolveEntry — fix (a): reused branch prefers an OPEN PR", () => {
  it("returns clean when an OPEN PR exists even though an older same-branch PR merged", () => {
    const gh = makeGh({
      list: {
        "feat/x": {
          open: [{ state: "OPEN", number: 99 }],
          merged: [{ number: 12, title: "old shipped" }],
        },
      },
    });
    expect(resolveEntry({ branch: "feat/x", pr: null }, gh).status).toBe("clean");
  });

  it("prefers an OPEN PR regardless of how many merged PRs exist (no truncation dependency)", () => {
    const manyMerged = Array.from({ length: 30 }, (_, i) => ({ number: i, title: `m${i}` }));
    const gh = makeGh({ list: { "feat/x": { open: [{ number: 99 }], merged: manyMerged } } });
    expect(resolveEntry({ branch: "feat/x", pr: null }, gh).status).toBe("clean");
  });

  it("returns stale when there is NO open PR and a merged one exists (exit-1 contract)", () => {
    const gh = makeGh({
      list: { "feat/x": { open: [], merged: [{ number: 42, title: "shipped" }] } },
    });
    const r = resolveEntry({ branch: "feat/x", pr: null }, gh);
    expect(r.status).toBe("stale");
    expect(r.merged.number).toBe(42);
  });

  it("returns clean for the no-OPEN/no-MERGED edge (empty, DRAFT, or CLOSED only)", () => {
    // A CLOSED-only branch surfaces as neither an open nor a merged hit.
    const gh = makeGh({ list: { "feat/x": { open: [], merged: [] } } });
    expect(resolveEntry({ branch: "feat/x", pr: null }, gh).status).toBe("clean");
  });
});

describe("resolveEntry — fix (b): number-only resolution downgrades to a warning", () => {
  it("returns warn (not stale) when a bare-number entry's PR is merged", () => {
    const gh = makeGh({ view: { "7": { state: "MERGED", title: "shipped elsewhere" } } });
    const r = resolveEntry({ branch: null, pr: "7" }, gh);
    expect(r.status).toBe("warn");
    expect(r.merged.number).toBe(7);
  });

  it("returns clean when a number-only entry's PR is still open", () => {
    const gh = makeGh({ view: { "7": { state: "OPEN", title: "in flight" } } });
    expect(resolveEntry({ branch: null, pr: "7" }, gh).status).toBe("clean");
  });
});

describe("scanTodo — fix (c): a transient error skips one entry, not the whole loop", () => {
  it("skips the transient entry and still finds the stale one that follows", () => {
    const text = todo(
      branchEntry("feat/flaky", "Flaky lookup"),
      branchEntry("feat/done", "Already shipped")
    );
    const gh = makeGh({
      list: {
        "feat/flaky": {
          open: () => {
            throw new GhTransient("HTTP 404");
          },
        },
        "feat/done": { open: [], merged: [{ number: 5, title: "Already shipped" }] },
      },
    });
    const scan = scanTodo(text, gh);
    expect(scan.skipped.map((s) => s.entry.branch)).toEqual(["feat/flaky"]);
    expect(scan.stale.map((s) => s.entry.branch)).toEqual(["feat/done"]);
    expect(scan.aborted).toBeNull();
  });
});

describe("scanTodo — GhUnavailable stops the loop but preserves already-found stale", () => {
  it("keeps a stale entry found before a mid-scan GhUnavailable and does not throw", () => {
    const text = todo(
      branchEntry("feat/done", "Already shipped"),
      branchEntry("feat/auth", "Auth expired here")
    );
    const gh = makeGh({
      list: {
        "feat/done": { open: [], merged: [{ number: 5, title: "Already shipped" }] },
        "feat/auth": {
          open: () => {
            throw new GhUnavailable("gh auth login");
          },
        },
      },
    });
    let scan = null;
    expect(() => {
      scan = scanTodo(text, gh);
    }).not.toThrow();
    expect(scan.stale.map((s) => s.entry.branch)).toEqual(["feat/done"]);
    expect(scan.aborted).toBeTruthy();
    const { exitCode, err } = summarize(scan);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/partial|unchecked|unavailable/i);
  });
});

describe("scanTodo — a number-only merged entry warns, never becomes stale", () => {
  it("lands the entry in warnings, keeps stale empty, exit 0", () => {
    const text = todo(numberEntry(7, "Number only"));
    const gh = makeGh({ view: { "7": { state: "MERGED", title: "shipped" } } });
    const scan = scanTodo(text, gh);
    expect(scan.stale).toHaveLength(0);
    expect(scan.warnings).toHaveLength(1);
    expect(summarize(scan).exitCode).toBe(0);
  });
});

describe("scanTodo — Finding 2: a taxonomy-external bug is rethrown, never swallowed", () => {
  it("propagates a raw TypeError out of the loop instead of reporting clean", () => {
    const text = todo(branchEntry("feat/x", "Boom"));
    const gh = () => {
      throw new TypeError("boom");
    };
    expect(() => scanTodo(text, gh)).toThrow(TypeError);
  });
});

describe("runScan — Finding 1: a bug becomes exit 2, never colliding with stale's exit 1", () => {
  it("maps a taxonomy-external error to exitCode 2 with an internal-error message", () => {
    const text = todo(branchEntry("feat/x", "Boom"));
    const { exitCode, err } = runScan(text, () => {
      throw new TypeError("boom");
    });
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/internal error/i);
  });

  it("still returns exitCode 1 for a genuinely stale marker (2 and 1 do not collide)", () => {
    const text = todo(branchEntry("feat/done", "Shipped"));
    const gh = makeGh({
      list: { "feat/done": { open: [], merged: [{ number: 5, title: "Shipped" }] } },
    });
    expect(runScan(text, gh).exitCode).toBe(1);
  });
});

describe("summarize — Finding 4 / honest partial-scan wording", () => {
  it("says 'partial' and exits 0 when entries were skipped but none are stale", () => {
    const scan = {
      inflightCount: 2,
      stale: [],
      warnings: [],
      skipped: [{ entry: { branch: "feat/a" }, reason: "404" }],
      aborted: null,
    };
    const { exitCode, out, err } = summarize(scan);
    expect(exitCode).toBe(0);
    expect([...out, ...err].join("\n")).toMatch(/partial/i);
  });

  it("does not say 'partial' on a fully clean scan", () => {
    const scan = { inflightCount: 1, stale: [], warnings: [], skipped: [], aborted: null };
    const { exitCode, out, err } = summarize(scan);
    expect(exitCode).toBe(0);
    expect([...out, ...err].join("\n")).not.toMatch(/partial/i);
  });

  it("exits 1 whenever a stale entry is present", () => {
    const scan = {
      inflightCount: 1,
      stale: [
        {
          entry: { branch: "feat/done", title: "Shipped" },
          merged: { number: 5, title: "Shipped" },
        },
      ],
      warnings: [],
      skipped: [],
      aborted: null,
    };
    expect(summarize(scan).exitCode).toBe(1);
  });
});

describe("classifyGhError — ENOENT / auth / rate-limit → GhUnavailable, else GhTransient", () => {
  it("classifies ENOENT and auth failures and rate limits as GhUnavailable", () => {
    expect(classifyGhError(Object.assign(new Error("spawn"), { code: "ENOENT" }))).toBeInstanceOf(
      GhUnavailable
    );
    expect(
      classifyGhError({ stderr: "gh: Not logged into any GitHub hosts. Run gh auth login" })
    ).toBeInstanceOf(GhUnavailable);
    expect(classifyGhError({ stderr: "API rate limit exceeded for user" })).toBeInstanceOf(
      GhUnavailable
    );
    expect(classifyGhError({ stderr: "HTTP 401: Bad credentials" })).toBeInstanceOf(GhUnavailable);
  });

  it("classifies a one-off HTTP error as GhTransient", () => {
    expect(classifyGhError({ stderr: "HTTP 404: Not Found" })).toBeInstanceOf(GhTransient);
  });
});

describe("ghExec — injectable exec exercises JSON.parse and the classification paths", () => {
  it("throws GhTransient on unparseable stdout", () => {
    expect(() => ghExec(["pr", "view", "1"], () => "not json")).toThrow(GhTransient);
  });

  it("returns parsed JSON on success", () => {
    expect(ghExec(["x"], () => '{"state":"MERGED"}')).toEqual({ state: "MERGED" });
  });

  it("throws GhUnavailable when the underlying exec reports ENOENT", () => {
    expect(() =>
      ghExec(["x"], () => {
        throw Object.assign(new Error("spawn"), { code: "ENOENT" });
      })
    ).toThrow(GhUnavailable);
  });
});

describe("parseEntry — extracts branch / pr / title from every marker form", () => {
  it("reads the modern (branch: X) form", () => {
    expect(parseEntry("- [ ] 🚧 **Feature** (branch: feat/foo)").branch).toBe("feat/foo");
  });
  it("reads the legacy <!-- branch: X --> form", () => {
    expect(parseEntry("- [ ] 🚧 **Feature** <!-- branch: feat/foo -->").branch).toBe("feat/foo");
  });
  it("reads (PR #12) and bare (#12) as a pr number", () => {
    expect(parseEntry("- [ ] 🚧 **Feature** (PR #12)").pr).toBe("12");
    expect(parseEntry("- [ ] 🚧 **Feature** (#12)").pr).toBe("12");
  });
  it("captures the **bold** title", () => {
    expect(parseEntry("- [ ] 🚧 **The title** (branch: b)").title).toBe("The title");
  });
});
