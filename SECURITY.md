# Security Policy

## Supported versions

Quoll is distributed through the VS Code Marketplace and Open VSX. Security fixes
are shipped only in a new published release, and only the latest published version
is supported.

| Version                | Supported          |
| ---------------------- | ------------------ |
| Latest published `0.1.x` | ✅                 |
| Any older version      | ❌ (upgrade first) |

If you are affected, update to the latest release before reporting — the fix may
already be published.

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue, pull
request, or discussion for anything security-sensitive.

Use GitHub's private vulnerability reporting for this repository:

1. Go to the **Security** tab of <https://github.com/mtskf/quoll>.
2. Choose **Report a vulnerability**.
3. Include a description, the affected version, reproduction steps, and the
   impact you observed.

This routes the report privately to the maintainer and lets us coordinate a fix
and disclosure with you.

## What to expect

- **Acknowledgement:** within 7 days of your report.
- **Assessment:** an initial severity assessment and next steps within 14 days.
- **Fix & disclosure:** for confirmed issues, a fix is published in a new release
  and the advisory is disclosed once users have had a reasonable window to update.

We will keep you informed of progress and credit you in the advisory unless you
ask us not to.

## Scope

This policy covers the **published** Quoll extension (VS Code Marketplace / Open
VSX) at the latest release.

Unpublished, development, or self-built artifacts (a local `pnpm build`, an
unreleased branch, a manually built `.vsix`) are **not** supported — unless the
same defect also affects a published release, in which case report it as above
and note that it reproduces on the release.
