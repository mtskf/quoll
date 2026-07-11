import { describe, expect, it } from "vitest";
import type { IsWritableFileSystem } from "../../src/extension/file-system.js";
import { canHostWrite } from "../../src/extension/session/can-host-write.js";

const writable: IsWritableFileSystem = () => true;
const readonly: IsWritableFileSystem = () => false;
const unknownScheme: IsWritableFileSystem = () => undefined;

describe("canHostWrite", () => {
  it("accepts a writable file:// document", () => {
    expect(canHostWrite("file", writable)).toBe(true);
  });

  it("accepts a file:// document when the FS scheme is unknown", () => {
    // `workspace.fs.isWritableFileSystem("file")` historically returns
    // `true`, but VS Code documents `undefined` as "unknown". For the
    // canonical `file:` scheme we keep the previous default of treating
    // unknown as writable so editing local Markdown still works on
    // builds where the API returns `undefined`.
    expect(canHostWrite("file", unknownScheme)).toBe(true);
  });

  it("refuses a file:// document marked read-only", () => {
    // Some virtual `file:` overlays (e.g. test harnesses) may mark the
    // filesystem read-only. Honour that explicit signal.
    expect(canHostWrite("file", readonly)).toBe(false);
  });

  it("refuses an empty-string scheme", () => {
    // Pinning the rejection of malformed URIs — the gate is a strict
    // equality check, so this documents that an empty scheme must not
    // accidentally pass under a future allowlist refactor.
    expect(canHostWrite("", writable)).toBe(false);
  });

  it("refuses uppercase FILE scheme (case-sensitive gate)", () => {
    // VS Code normalises URI schemes to lowercase internally, but the
    // gate is intentionally case-sensitive. Rejecting "FILE" documents
    // the assumption so a future `.toLowerCase()` normalisation would
    // be caught here rather than silently widening the allowlist.
    expect(canHostWrite("FILE", writable)).toBe(false);
  });

  // These cases are the regression this gate exists to prevent. Before
  // the gate tightened, `canWriteNow` accepted any scheme whose
  // `isWritableFileSystem` result was not literally `false`. A direct
  // `vscode.openWith` (bypassing `quoll.editWith` / `canEditWith`)
  // or a custom-editor restore on a non-`file:` URI could therefore
  // emit accepted writes.
  it.each([
    "untitled",
    "git",
    "vscode-vfs",
    "vscode-userdata",
    "output",
    "https",
    "http",
    "untitled-1",
    "x-quoll-virtual",
  ])("refuses non-file scheme %s even when FS is reported writable", (scheme) => {
    expect(canHostWrite(scheme, writable)).toBe(false);
  });

  it.each([
    "untitled",
    "git",
    "vscode-vfs",
    "vscode-userdata",
    "output",
    "https",
    "http",
    "untitled-1",
    "x-quoll-virtual",
    "x-extension-provided",
  ])("refuses non-file scheme %s when FS scheme is unknown", (scheme) => {
    // Threat model: an extension-provided custom scheme will typically
    // return `undefined` from `isWritableFileSystem`. The previous gate
    // (`result !== false`) would have treated this as writable. The
    // tightened gate must reject it. This list is a superset of the
    // "writable" batch above (adds `x-extension-provided`, which
    // typically returns `undefined` rather than `true`) so a future
    // change to the check order is caught for every scheme under both
    // FS-result scenarios.
    expect(canHostWrite(scheme, unknownScheme)).toBe(false);
  });

  it("does not consult isWritableFileSystem for non-file schemes", () => {
    // Scheme rejection must short-circuit. If the FS adapter throws, a
    // non-`file:` scheme should still be rejected before that throw is
    // reachable.
    const throwing: IsWritableFileSystem = () => {
      throw new Error("isWritableFileSystem should not be called for non-file schemes");
    };
    expect(canHostWrite("untitled", throwing)).toBe(false);
    expect(canHostWrite("git", throwing)).toBe(false);
    expect(canHostWrite("x-extension-provided", throwing)).toBe(false);
  });
});
