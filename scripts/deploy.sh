#!/bin/bash
# Local build + package, optionally publish.
# Usage:
#   ./scripts/deploy.sh                # build + package -> .vsix in repo root
#   ./scripts/deploy.sh --publish      # also runs `vsce publish` (needs VSCE_PAT + publisher set up)
set -e

cd "$(dirname "$0")/.."

echo "==> Installing extension deps..."
pnpm install --frozen-lockfile

echo "==> Building (webview + extension + esbuild bundle)..."
pnpm build

echo "==> Packaging .vsix..."
pnpm exec vsce package --no-dependencies

echo "==> Auditing .vsix contents..."
# Resolve the freshly-built .vsix (quoll-<version>.vsix in repo root)
# and gate the local publish on the same allowlist CI uses. Mirrors
# .github/workflows/publish.yml's "Audit .vsix contents" step.
VSIX_FILE="quoll-$(node -p "require('./package.json').version").vsix"
node scripts/audit-vsix.mjs "$VSIX_FILE"

if [[ "${1:-}" == "--publish" ]]; then
  echo "==> Publishing to VS Code Marketplace..."
  pnpm exec vsce publish --no-dependencies --packagePath "$VSIX_FILE"
else
  echo ""
  echo "Done. .vsix file created in repo root."
  echo "Run with --publish flag to publish to the Marketplace (requires VSCE_PAT + publisher in package.json)."
fi
