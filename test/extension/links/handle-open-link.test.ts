import { describe, expect, it } from "vitest";
import { Uri } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts (joinPath only)
import {
  type HandleOpenLinkDeps,
  handleOpenLink,
} from "../../../src/extension/links/handle-open-link.js";
import {
  OPEN_LINK_CONTAINMENT_ONLY_REJECTIONS,
  OPEN_LINK_DOC_LAYOUT,
  OPEN_LINK_STRUCTURAL_MATRIX,
} from "../../fixtures/open-link-destinations.js";

const makeUri = (path: string) => ({ path }) as unknown as import("vscode").Uri;

// documentUri = /ws/notes/doc.md ; workspace root = /ws — taken from the shared
// fixture, since every `hostRoutes` verdict in the matrix is stated against
// exactly this layout.
function makeDeps(overrides: Partial<HandleOpenLinkDeps> = {}) {
  const opened: string[] = [];
  const errors: string[] = [];
  const deps: HandleOpenLinkDeps = {
    documentUri: makeUri(OPEN_LINK_DOC_LAYOUT.documentPath),
    joinPath: (base, ...segments) => Uri.joinPath(base, ...segments),
    isInWorkspace: (uri) => uri.path.startsWith(`${OPEN_LINK_DOC_LAYOUT.workspaceRoot}/`),
    openWith: (uri) => {
      opened.push(uri.path);
      return Promise.resolve(undefined);
    },
    showError: (m) => {
      errors.push(m);
    },
    ...overrides,
  };
  return { deps, opened, errors };
}

// The cross-boundary half of this suite. Every row below is asserted by the
// webview suite too (test/webview/cm-link-target.test.ts) off the SAME fixture,
// so `handleOpenLink`'s cascade cannot drift from the webview's
// `relativeMarkdownTarget` copy without reddening both files. Read the fixture
// header for what the matrix does and does not claim.
describe("handleOpenLink — shared open-link structural matrix", () => {
  for (const { destination, hostRoutes, why } of OPEN_LINK_STRUCTURAL_MATRIX) {
    it(`${hostRoutes ? "routes" : "does not route"} — ${why}`, () => {
      const { deps, opened, errors } = makeDeps();
      handleOpenLink(destination, deps);
      // Whether it routed, not where to: the resolved path is host-only
      // information the shared fixture cannot carry, and is pinned below.
      expect(opened.length > 0).toBe(hostRoutes);
      // NO row in this matrix may toast, in either direction. Every structural
      // gate is mirrored webview-side, which withholds the pointer cursor and
      // never posts — so reaching one of these rejects at runtime means the two
      // copies drifted, which is a log line for a maintainer, not a message for
      // a user who never clicked anything. Asserting it here (rather than only
      // on the containment rows below) is what stops the containment toast from
      // being generalised to every drop arm.
      expect(errors).toEqual([]);
    });
  }
});

// The one place the two sides legitimately disagree. These pass every
// structural gate — the webview classifies them as `workspace` and posts them —
// and are dropped here, on containment, because only the host owns document.uri
// and can resolve them. Pinned so it stays a documented split of responsibility
// rather than looking like the drift the matrix above exists to catch.
describe("handleOpenLink — containment rejects what the structural gates let through", () => {
  for (const { destination, why } of OPEN_LINK_CONTAINMENT_ONLY_REJECTIONS) {
    it(`drops a posted destination that escapes scope — ${why}`, () => {
      const { deps, opened } = makeDeps();
      handleOpenLink(destination, deps);
      expect(opened).toEqual([]);
    });

    // The flip side of that asymmetry, and the reason this arm alone speaks:
    // the webview already promised the click (pointer cursor) and consumed it
    // (preventDefault, which eats the caret move), because containment is the
    // one gate it cannot run. Dropping silently here spends a real click on
    // nothing observable. Pinned per-destination so the signal cannot be lost
    // for the decoded form while surviving for the plain one.
    it(`tells the user it refused, without naming the target — ${why}`, () => {
      const { deps, errors } = makeDeps();
      handleOpenLink(destination, deps);
      expect(errors).toEqual([
        "Quoll: that link points outside this workspace and the document's folder — it wasn't opened.",
      ]);
      // The destination is untrusted webview-supplied text: it stays out of the
      // toast (host chrome) and goes only to the sanitised log line.
      expect(errors[0]).not.toContain(destination);
    });
  }
});

describe("handleOpenLink", () => {
  it("opens a same-directory .md link", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.md", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
  });

  it("opens a parent-relative .md link that stays in the workspace", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("../sibling/other.md", deps);
    expect(opened).toEqual(["/ws/sibling/other.md"]);
  });

  it("strips a #fragment before resolving", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./other.md#section", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
  });

  it("falls back to the document directory when there is no workspace (single-file open)", () => {
    const { deps, opened, errors } = makeDeps({ isInWorkspace: () => false });
    handleOpenLink("./other.md", deps);
    expect(opened).toEqual(["/ws/notes/other.md"]);
    // ...and says NOTHING while doing it. The two containment conditions are an
    // AND: being outside the workspace is only half a refusal, because the
    // document's own directory is the other way to be in scope. Deriving the
    // toast from `!isInWorkspace` alone still OPENS the file, so no `opened`
    // assertion anywhere can catch it — the whole symptom is that every
    // legitimate click in single-file operation grows a false "it wasn't
    // opened" toast. This is the only test positioned to see that, since it is
    // the only success path with no workspace.
    expect(errors).toEqual([]);
  });

  it("rejects a parent escape when there is no workspace", () => {
    const { deps, opened, errors } = makeDeps({ isInWorkspace: () => false });
    handleOpenLink("../other.md", deps);
    expect(opened).toEqual([]);
    // Same refusal toast on the no-workspace arm: containment there is the
    // document's own directory, and the user is owed the same signal.
    expect(errors).toEqual([expect.stringContaining("points outside this workspace")]);
  });

  // The plain structural rejects — non-.md, absolute, backslash, scheme-bearing,
  // protocol-relative and fragment-only — now live in the shared matrix above,
  // which asserts the same "nothing opened" outcome AND holds the webview copy
  // of the cascade to it. Only what the fixture cannot express stays here: deps
  // overrides, resolved paths, and the failure toast.

  it("rejects a sibling dir that shares the doc-dir name as a prefix (no workspace)", () => {
    // /ws/notes vs /ws/notes-evil must NOT match on a bare prefix — guards the
    // trailing-slash normalisation in isWithinDir (without it, startsWith would
    // wrongly accept the sibling).
    const { deps, opened, errors } = makeDeps({ isInWorkspace: () => false });
    handleOpenLink("../notes-evil/secret.md", deps);
    expect(opened).toEqual([]);
    expect(errors).toEqual([expect.stringContaining("points outside this workspace")]);
  });

  it("decodes a percent-encoded space so my%20notes.md opens my notes.md", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./my%20notes.md", deps);
    expect(opened).toEqual(["/ws/notes/my notes.md"]);
  });

  it("decodes a percent-encoded space inside a subdirectory segment", () => {
    const { deps, opened } = makeDeps();
    handleOpenLink("./sub%20dir/my%20notes.md", deps);
    expect(opened).toEqual(["/ws/notes/sub dir/my notes.md"]);
  });

  it("leaves a malformed percent-escape literal (no decode, still opens)", () => {
    // decodeURIComponent throws on `%of`; we fall back to the raw form so a real
    // file literally named `50%off.md` still opens (no regression vs pre-fix).
    const { deps, opened } = makeDeps();
    handleOpenLink("./50%off.md", deps);
    expect(opened).toEqual(["/ws/notes/50%off.md"]);
  });

  it("falls back to the raw form when a segment mixes a valid and invalid escape", () => {
    // decodeURIComponent is all-or-nothing: %20 is NOT partially decoded when a
    // later %off is malformed. Whole-string raw fallback → literal-named target.
    const { deps, opened } = makeDeps();
    handleOpenLink("./sub%20dir/50%off.md", deps);
    expect(opened).toEqual(["/ws/notes/sub%20dir/50%off.md"]);
  });

  it("shows the failure toast when openWith rejects asynchronously", async () => {
    const { deps, errors } = makeDeps({ openWith: () => Promise.reject(new Error("boom")) });
    handleOpenLink("./other.md", deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([expect.stringContaining("couldn't open the linked file")]);
  });

  it("shows the failure toast when openWith throws synchronously", () => {
    const { deps, errors } = makeDeps({
      openWith: () => {
        throw new Error("sync boom");
      },
    });
    handleOpenLink("./other.md", deps);
    expect(errors).toEqual([expect.stringContaining("couldn't open the linked file")]);
  });
});
