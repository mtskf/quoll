import { describe, expect, it } from "vitest";
import {
  type DocumentWriteAdapter,
  type DocumentWriteOutcome,
  executeDocumentWrite,
} from "../../../src/extension/document-write/execute-write.js";

// A mutable fake document + adapter with a CALL LOG. `apply` mutates `text`
// (and bumps `version`) via the injected `onApply`, so a test can model a clean
// apply, a diverging (misplaced / external-won) apply, a refusal, or a throw.
// `readCanonical` returns the live `text` verbatim (the fakes already speak in
// the canonical EOL), so the executor's `settledContent === intendedContent`
// divergence check exercises real bytes.
interface FakeOptions {
  initial: string;
  /** Apply behaviour. Return false → refused; throw sync → applyThrew; reject →
   *  applyRejected. Mutate `d` to model what LANDED (clean vs diverged). */
  onApply?: (d: { text: string; version: number }) => boolean | Promise<boolean>;
  /** build() throws when set. */
  buildThrows?: boolean;
}

/** onApply that models a CLEAN landing of `text` (bumps version, resolves true). */
const land = (text: string) => (d: { text: string; version: number }) => {
  d.text = text;
  d.version += 1;
  return true;
};

function makeFake(opts: FakeOptions) {
  const calls: string[] = [];
  const d = { text: opts.initial, version: 1 };
  const adapter: DocumentWriteAdapter = {
    readText: () => {
      calls.push("readText");
      return d.text;
    },
    readVersion: () => {
      calls.push("readVersion");
      return d.version;
    },
    readCanonical: () => {
      calls.push("readCanonical");
      return d.text;
    },
    canonicalize: (t) => {
      calls.push("canonicalize");
      return t;
    },
    build: (span) => {
      calls.push("build");
      if (opts.buildThrows) {
        throw new Error("build boom");
      }
      return span;
    },
    apply: (_edit) => {
      calls.push("apply");
      const behaviour =
        opts.onApply ??
        ((doc) => {
          doc.version += 1;
          return true;
        });
      return Promise.resolve().then(() => behaviour(d));
    },
  };
  return { adapter, calls, d };
}

/** Assert the outcome carries all four verification-time snapshots as strings/
 *  number (contract: every terminal outcome populates them). */
function expectFourSnapshots(o: DocumentWriteOutcome): void {
  expect(typeof o.intendedContent).toBe("string");
  expect(typeof o.preApplyContent).toBe("string");
  expect(typeof o.settledContent).toBe("string");
  expect(typeof o.settledVersion).toBe("number");
}

describe("executeDocumentWrite — tag mapping", () => {
  it("clean apply (landed === intended) → applied", async () => {
    const { adapter } = makeFake({
      initial: "old",
      onApply: (d) => {
        d.text = "new";
        d.version += 1;
        return true;
      },
    });
    const o = await executeDocumentWrite(adapter, "new");
    expect(o.tag).toBe("applied");
    expect(o.settledContent).toBe("new");
    expect(o.intendedContent).toBe("new");
    expect(o.settledVersion).toBe(2);
  });

  it("apply ok but landed content DIVERGES from intended → diverged", async () => {
    // Misplaced / external-won: apply resolves true, but the document ends up
    // holding something other than the intended bytes.
    const { adapter } = makeFake({
      initial: "old",
      onApply: (d) => {
        d.text = "CORRUPTED-by-racing-edit";
        d.version += 1;
        return true;
      },
    });
    const o = await executeDocumentWrite(adapter, "new");
    expect(o.tag).toBe("diverged");
    expect(o.settledContent).toBe("CORRUPTED-by-racing-edit");
    expect(o.intendedContent).toBe("new");
  });

  it("apply resolves false → applyRefused", async () => {
    const { adapter } = makeFake({ initial: "old", onApply: () => false });
    const o = await executeDocumentWrite(adapter, "new");
    expect(o.tag).toBe("applyRefused");
  });

  it("build throws → buildThrew (carries the message + snapshots)", async () => {
    const { adapter, calls } = makeFake({ initial: "old", buildThrows: true });
    const o = await executeDocumentWrite(adapter, "new");
    expect(o.tag).toBe("buildThrew");
    expect(o.message).toContain("build boom");
    // apply was never reached.
    expect(calls).not.toContain("apply");
  });

  it("apply throws synchronously → applyThrew", async () => {
    const { adapter } = makeFake({
      initial: "old",
      onApply: () => {
        throw new Error("apply boom");
      },
    });
    // The synchronous throw is inside the deferred `.then`, so model a sync
    // throw by making `apply` itself throw before returning a Thenable.
    const throwingAdapter: DocumentWriteAdapter = {
      ...adapter,
      apply: () => {
        throw new Error("apply boom");
      },
    };
    const o = await executeDocumentWrite(throwingAdapter, "new");
    expect(o.tag).toBe("applyThrew");
    expect(o.message).toContain("apply boom");
  });

  it("apply promise rejects → applyRejected", async () => {
    const { adapter } = makeFake({
      initial: "old",
      onApply: () => Promise.reject(new Error("reject boom")),
    });
    const o = await executeDocumentWrite(adapter, "new");
    expect(o.tag).toBe("applyRejected");
    expect(o.message).toContain("reject boom");
  });

  it("no-op span → applied WITHOUT calling build/apply", async () => {
    const { adapter, calls } = makeFake({ initial: "same" });
    const o = await executeDocumentWrite(adapter, "same");
    expect(o.tag).toBe("applied");
    expect(calls).not.toContain("build");
    expect(calls).not.toContain("apply");
  });
});

describe("executeDocumentWrite — contract: every terminal outcome carries four snapshots", () => {
  const cases: Array<[string, FakeOptions, string]> = [
    ["applied", { initial: "old", onApply: land("new") }, "applied"],
    ["diverged", { initial: "old", onApply: land("X") }, "diverged"],
    ["applyRefused", { initial: "old", onApply: () => false }, "applyRefused"],
    ["buildThrew", { initial: "old", buildThrows: true }, "buildThrew"],
    [
      "applyRejected",
      { initial: "old", onApply: () => Promise.reject(new Error("x")) },
      "applyRejected",
    ],
  ];
  for (const [name, options, tag] of cases) {
    it(`${name} populates intended/preApply/settled/version`, async () => {
      const { adapter } = makeFake(options);
      const o = await executeDocumentWrite(adapter, "new");
      expect(o.tag).toBe(tag);
      expectFourSnapshots(o);
      // preApply always reflects the original text; buildThrew never mutated it.
      expect(o.preApplyContent).toBe("old");
    });
  }

  it("applyThrew (sync) also populates all four snapshots", async () => {
    const { adapter } = makeFake({ initial: "old" });
    const o = await executeDocumentWrite(
      {
        ...adapter,
        apply: () => {
          throw new Error("x");
        },
      },
      "new"
    );
    expect(o.tag).toBe("applyThrew");
    expectFourSnapshots(o);
  });
});

describe("executeDocumentWrite — contract: no document read after the outcome resolves", () => {
  it("the executor performs NO adapter call after the returned promise resolves", async () => {
    const { adapter, calls } = makeFake({ initial: "old", onApply: land("new") });
    const o = await executeDocumentWrite(adapter, "new");
    const callsAtResolve = calls.length;
    // The outcome already carries settledContent/settledVersion — a caller maps
    // from THOSE, never re-reads. Give any stray microtask a tick, then assert
    // the executor issued no further adapter calls.
    await Promise.resolve();
    expect(calls.length).toBe(callsAtResolve);
    expect(o.settledVersion).toBe(2);
  });

  it("settledContent is captured at VERIFY time (post-apply), not pre-apply", async () => {
    const { adapter } = makeFake({ initial: "old", onApply: land("landed-after-apply") });
    const o = await executeDocumentWrite(adapter, "landed-after-apply");
    // preApply is the OLD buffer; settled is the POST-apply document.
    expect(o.preApplyContent).toBe("old");
    expect(o.settledContent).toBe("landed-after-apply");
    expect(o.tag).toBe("applied");
  });
});

describe("executeDocumentWrite — EOL canonicalisation is load-bearing (false-divergence guard)", () => {
  // A CRLF-eol document seam: `canonicalize` normalises every EOL token to CRLF
  // (as canonicalizeText does for a CRLF `document.eol`), and `readCanonical`
  // reads the doc through the SAME canonicaliser. The webview target `content`
  // arrives LF-joined. This is the exact skew the plan warns about: without
  // canonicalising the intended content, a CLEAN apply on a CRLF doc would read
  // as `diverged` → spurious epoch bump → retry-buffer drop = keystroke loss.
  const toCrlf = (t: string) => t.replace(/\r\n|\r|\n/g, "\r\n");
  // `landsClean` models VS Code storing the inserted LF target normalised to the
  // doc's CRLF EOL on a successful apply.
  function crlfAdapter(docText: string, target: string): DocumentWriteAdapter {
    const doc = { text: docText };
    return {
      readText: () => doc.text,
      readVersion: () => 1,
      readCanonical: () => toCrlf(doc.text),
      canonicalize: toCrlf,
      build: (span) => span,
      apply: () => {
        doc.text = toCrlf(target);
        return Promise.resolve(true);
      },
    };
  }

  it("a clean apply on a CRLF doc with an LF webview target is APPLIED, not diverged (intended is canonicalised before compare)", async () => {
    const intended = "line one\nline two\n"; // LF webview bytes
    const adapter = crlfAdapter("old\ntext\n", intended);
    const o = await executeDocumentWrite(adapter, intended);
    // settledContent (CRLF) === intendedContent (CRLF) — a direct compare against
    // the RAW LF `content` would be "line one\r\nline two\r\n" !== "line one\nline
    // two\n" → a false `diverged`. This pins the canonicalise(content) call.
    expect(o.tag).toBe("applied");
    expect(o.intendedContent).toBe("line one\r\nline two\r\n");
    expect(o.settledContent).toBe("line one\r\nline two\r\n");
  });

  it("preApplyContent is the CANONICALISED pre-apply buffer, not the raw getText()", async () => {
    const adapter = crlfAdapter("pre\napply\n", "whatever\n"); // raw LF buffer
    const o = await executeDocumentWrite(adapter, "whatever\n");
    // Pins the canonicalise(oldText) call — the non-ok epoch baseline depends on
    // it; a raw passthrough would mismatch the canonical settlement read.
    expect(o.preApplyContent).toBe("pre\r\napply\r\n");
  });
});
