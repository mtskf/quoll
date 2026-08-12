#!/usr/bin/env bash
# Assemble the SHIPPED runtime dependency closure in a throwaway staging tree —
# the source syft catalogs for the SBOM (publish.yml at release, ci.yml's `sbom`
# job on every PR). Shared by both so the CI rehearsal cannot drift from the
# release path; the steps that consume this tree are kept identical by
# test/build/publish-workflow-sbom-config.test.ts.
#
# A prod-only frozen install yields a node_modules containing exactly the runtime
# closure at EXACT resolved versions. The lockfile is then removed so syft
# catalogs that node_modules rather than the dev-inclusive lock graph — and the
# residual hidden node_modules/.pnpm/lock.yaml is named `lock.yaml`, not
# `pnpm-lock.yaml`, so syft's pnpm-lock cataloger does not match it.
#
# package.json + pnpm-lock.yaml + pnpm-workspace.yaml (overrides + release-age
# cooldown) + .npmrc (hoist/registry policy) are all copied so
# --frozen-lockfile resolves identically to the real install.
#
# Usage: scripts/assemble-sbom-staging.sh <stagingDir>
# Callers pass a dir OUTSIDE the checkout (both workflows use
# "$RUNNER_TEMP/sbom-src"), and the guards below enforce it, so the tree can
# never be picked up by publish.yml's package/audit/attest steps and that
# workflow's workspace node_modules — still needed there for the dev-only vsce —
# stays intact. That second half is publish.yml-specific: ci.yml's `sbom` job
# runs no root install and has no Package step.
set -euo pipefail

STAGING="${1:-}"

# Fail closed BEFORE the rm -rf below. This script deletes whatever path it is
# handed, so a caller typo (empty, relative, `/`, the checkout itself, or a path
# inside it) must be rejected rather than executed.
if [ -z "$STAGING" ]; then
  echo "::error::assemble-sbom-staging: missing <stagingDir> argument" >&2
  exit 2
fi
case "$STAGING" in
  /*) ;;
  *)
    echo "::error::assemble-sbom-staging: <stagingDir> must be absolute, got '$STAGING'" >&2
    exit 2
    ;;
esac
# Reject the root in every spelling. `[ "$(dirname "$S")" = "$S" ]` alone is NOT
# enough: `dirname //` is `/`, so "//" (and "///") would slip through and get
# rebuilt into another all-slash path below. Matching "contains no non-slash
# character" covers "/", "//", "///" in one rule. We do not fall back on rm's own
# root protection — this script's contract is to exit 2 without touching the
# filesystem at all.
case "$STAGING" in
  *[!/]*) ;;
  *)
    echo "::error::assemble-sbom-staging: refusing to use the filesystem root as <stagingDir>" >&2
    exit 2
    ;;
esac

# Canonicalize BEFORE the containment check below. A raw string comparison is
# trivially bypassable: "<repo>/.." is absolute, is not the root, and does not
# have the repo root as a prefix — yet rm -rf on it would delete the repo's
# parent. Reject a `.`/`..` basename outright, then resolve the PARENT
# physically (it must already exist) and rebuild the path from it, so interior
# `..` segments and symlinked parents collapse before anything is compared.
# A symlink AT the leaf needs no special handling: rm -rf removes the link, not
# its target, and mkdir -p then creates a real directory.
STAGING_NAME="$(basename "$STAGING")"
case "$STAGING_NAME" in
  . | ..)
    echo "::error::assemble-sbom-staging: <stagingDir> must name a directory, got '$STAGING'" >&2
    exit 2
    ;;
esac
STAGING_PARENT="$(cd "$(dirname "$STAGING")" && pwd -P)" || {
  echo "::error::assemble-sbom-staging: parent directory of '$STAGING' is not an accessible directory (see the shell error above)" >&2
  exit 2
}
# `pwd -P` of the root is "/", so joining with "/" naively yields "//name" — a
# path that works but no longer shares a textual prefix with REPO_ROOT, which
# would silently weaken the containment check below.
if [ "$STAGING_PARENT" = "/" ]; then
  STAGING="/$STAGING_NAME"
else
  STAGING="$STAGING_PARENT/$STAGING_NAME"
fi
# POSIX permits a "//"-rooted path as a distinct root, and bash's cd/pwd -P
# PRESERVE that prefix (zsh collapses it, which is why a shell probe can look
# safe). So "//<repo>" would evade the textual containment check below while
# rm -rf still resolves it to the real repo root. Collapse to a single leading
# slash before anything is compared.
while :; do
  case "$STAGING" in
    //*) STAGING="/${STAGING#//}" ;;
    *) break ;;
  esac
done

# Run from the repo root regardless of the caller's cwd, so the cp sources below
# resolve against the checkout rather than whatever dir the step ran in.
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
# Collapse REPO_ROOT the same way, for the same reason: both checks below are
# TEXTUAL comparisons, so a "//"-rooted path on EITHER side blinds them. STAGING
# is normalised above, but REPO_ROOT inherits its prefix from "$0" — invoke this
# script as "//<repo>/scripts/assemble-sbom-staging.sh" and cd/pwd -P keep the
# "//", so the checkout itself would sail past both arms.
while :; do
  case "$REPO_ROOT" in
    //*) REPO_ROOT="/${REPO_ROOT#//}" ;;
    *) break ;;
  esac
done
case "$REPO_ROOT" in
  "$STAGING" | "$STAGING"/*)
    echo "::error::assemble-sbom-staging: refusing to delete '$STAGING' — it is the repo root or contains it" >&2
    exit 2
    ;;
esac
# The symmetric arm. The check above only rejects "STAGING is the checkout or an
# ancestor of it"; a path INSIDE the checkout passed every guard, which both
# deletes checkout content and leaves the staging tree where the
# package/audit/attest steps would pick it up — the contamination this staging
# design exists to prevent.
case "$STAGING" in
  "$REPO_ROOT"/*)
    echo "::error::assemble-sbom-staging: refusing '$STAGING' — the staging tree must live outside the repo checkout" >&2
    exit 2
    ;;
esac

rm -rf "$STAGING"
mkdir -p "$STAGING"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$STAGING"/
if [ -f .npmrc ]; then cp .npmrc "$STAGING"/; fi
( cd "$STAGING" && pnpm install --prod --frozen-lockfile --ignore-scripts )
rm -f "$STAGING/pnpm-lock.yaml"
