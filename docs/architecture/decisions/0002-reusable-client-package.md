# ADR-002: Use a Reusable Client Package as the Protocol Core

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

All strict protocol behavior lives in an ESM-only Node.js 20+ workspace package
named `@a2a-workbench/client`. It has no React or Next.js dependency. The Next.js
route and external hosts consume only its declared exports.

## Consequences

Protocol behavior has one implementation and is independently testable. The host,
not the package, owns deployment-specific SSRF and response-size policy.

