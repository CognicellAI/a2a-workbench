# ADR-003: Pin the Official SDK Behind a Validating Façade

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

Pin `@a2a-js/sdk@1.0.0-beta.0` without a version range. Wrap its JSON-RPC and REST
transports behind an internal façade that preselects the exact Agent Card interface,
injects service headers, records evidence, and validates all wire values against a
pinned v1 schema plus semantic rules.

## Consequences

SDK replacement is localized and its beta surface does not become the public API.
The package carries validation work the SDK does not guarantee at its boundary.

