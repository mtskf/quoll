// Pins the local `pnpm package` → audit-vsix wiring.
//
// The audit gate (scripts/audit-vsix.mjs) is authoritative for what the
// .vsix may ship, but it was originally wired ONLY into CI
// (.github/workflows/ci.yml) and the local publish path (scripts/deploy.sh).
// The `package` npm script — the manual-install path a `.vsix` gets built
// from before `code --install-extension` — skipped it entirely, so a
// locally-built bundle could leak stale `dist/**/*.map` from a prior
// watch/dev build (`.vscodeignore` re-includes `!dist/**`; the allowlist
// permits only `.(cjs|js|css|json)` under dist/).
//
// This test asserts the `package` script both packages AND runs the audit,
// so a revert of the chaining goes red here rather than surfacing as a
// leaked artifact in a shipped .vsix. (Audit *correctness* against a real
// archive is covered by CI running the script on every PR's packaged .vsix.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
);

describe("pnpm package audit wiring", () => {
  const packageScript: string = pkg.scripts.package;

  it("packages the .vsix", () => {
    expect(packageScript).toContain("vsce package");
  });

  it("runs the audit-vsix gate after packaging", () => {
    expect(packageScript).toContain("scripts/audit-vsix.mjs");
    // The audit must run AFTER the package step, not before (there is no
    // .vsix to inspect until vsce has emitted it).
    expect(packageScript.indexOf("vsce package")).toBeLessThan(
      packageScript.indexOf("scripts/audit-vsix.mjs")
    );
  });
});
