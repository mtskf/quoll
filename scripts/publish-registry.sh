#!/usr/bin/env bash
set -euo pipefail

# The build's digest ties the three independent downloads to the same audited
# .vsix bytes. download-artifact checks the archive for each download.
if [[ $# -ne 3 ]]; then
  echo '::error::Usage: publish-registry.sh <marketplace|openvsx> <vsix> <expected-sha256>' >&2
  exit 1
fi

registry=$1
vsix=$2
expected_sha256=$3

if [[ "$registry" != marketplace && "$registry" != openvsx ]]; then
  echo '::error::Unknown publish registry.' >&2
  exit 1
fi

if [[ -z "$expected_sha256" ]]; then
  echo '::error::Expected VSIX SHA-256 is empty.' >&2
  exit 1
fi

if ! checksum=$(sha256sum < "$vsix") || [[ "${checksum%% *}" != "$expected_sha256" ]]; then
  echo '::error::VSIX SHA-256 does not match the audited build.' >&2
  exit 1
fi

if [[ "$registry" == marketplace ]]; then
  exec pnpm exec vsce publish --oidc --no-dependencies --packagePath "$vsix"
fi

# An empty token would send the CLI to an interactive prompt on the runner.
if [[ -z "${OVSX_PAT:-}" ]]; then
  echo '::error::OPENVSX_PAT is unset or empty. Set it before retrying the Open VSX job.' >&2
  exit 1
fi

exec pnpm exec ovsx publish "$vsix"
