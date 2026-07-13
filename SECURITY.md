# Security Policy

## Supported Versions

Security fixes are accepted for the latest commit on `main` until the project publishes versioned releases.

## Reporting A Vulnerability

Please report suspected vulnerabilities privately to the project maintainers. If a public GitHub repository is configured, prefer GitHub's private vulnerability reporting flow.

Do not open a public issue containing credentials, exploit details, private endpoint URLs, or live tokens.

## Deployment Warning

This project is intended as a local developer workbench. The server route can forward operator-supplied prompts and credentials to configured A2A endpoints.

Before hosting this app for other users, configure:

- Authentication for the app itself.
- `A2A_UPSTREAM_ALLOWLIST` for approved upstream hosts.
- Appropriate `A2A_UPSTREAM_TIMEOUT_MS` and `A2A_UPSTREAM_MAX_BYTES` limits.
- Network controls around private address ranges.

Keep `A2A_ALLOW_PRIVATE_NETWORKS=false` unless the instance is protected and intentionally scoped to private endpoint testing.
