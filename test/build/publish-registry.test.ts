import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/publish-registry.sh", import.meta.url));
const token = "test-openvsx-token";
const bytes = "audited VSIX fixture\n";
const digest = createHash("sha256").update(bytes).digest("hex");

describe("publish-registry", () => {
  let root: string;
  let vsix: string;
  let log: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quoll-publish-"));
    vsix = join(root, "audited extension.vsix");
    log = join(root, "publisher.jsonl");
    writeFileSync(vsix, bytes);
    writeFileSync(log, "");
    writeFileSync(
      join(root, "pnpm"),
      `#!${process.execPath}
const { createHash } = require("node:crypto");
const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const digest = createHash("sha256").update(readFileSync(argv.at(-1))).digest("hex");
appendFileSync(process.env.MOCK_LOG, JSON.stringify({ argv, digest }) + "\\n");
const registry = argv[1] === "vsce" ? "MARKETPLACE" : "OPENVSX";
process.exitCode = process.env["MOCK_FAIL_" + registry] === "1" ? 1 : 0;
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function publish(registry: string, expected = digest, overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync(script, [registry, vsix, expected], {
      encoding: "utf8",
      env: {
        PATH: [root, process.env.PATH].join(delimiter),
        MOCK_LOG: log,
        OVSX_PAT: token,
        ...overrides,
      },
    });
  }

  function calls(): { argv: string[]; digest: string }[] {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("publishes the same bytes when only the failed registry is retried", () => {
    // Model GitHub's failed-job retry: attempt two reuses the artifact and
    // runs Open VSX only. The workflow suite checks the dependency chain.
    const marketplace = publish("marketplace");
    expect(marketplace.error).toBeUndefined();
    expect(marketplace.status).toBe(0);
    expect(publish("openvsx", digest, { MOCK_FAIL_OPENVSX: "1" }).status).toBe(1);
    expect(publish("openvsx").status).toBe(0);

    expect(calls()).toEqual([
      {
        argv: ["exec", "vsce", "publish", "--oidc", "--no-dependencies", "--packagePath", vsix],
        digest,
      },
      { argv: ["exec", "ovsx", "publish", vsix], digest },
      { argv: ["exec", "ovsx", "publish", vsix], digest },
    ]);
    expect(
      calls()
        .flatMap(({ argv }) => argv)
        .join("\n")
    ).not.toContain(token);
  });

  it("fails red on a Marketplace publish failure without reaching Open VSX", () => {
    const result = publish("marketplace", digest, { MOCK_FAIL_MARKETPLACE: "1" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(calls()).toEqual([
      {
        argv: ["exec", "vsce", "publish", "--oidc", "--no-dependencies", "--packagePath", vsix],
        digest,
      },
    ]);
  });

  it.each([
    ["a digest mismatch", "marketplace", "0".repeat(64), token],
    ["an empty digest", "marketplace", "", token],
    ["an unknown registry", "unknown", digest, token],
    ["an empty Open VSX token", "openvsx", digest, ""],
  ])("rejects %s before calling a publisher", (_label, registry, expected, pat) => {
    const result = publish(registry, expected, { OVSX_PAT: pat });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(calls()).toEqual([]);
  });
});
