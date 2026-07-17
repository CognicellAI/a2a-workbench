# ADR-001: Separate Strict and Compatibility APIs

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

The package root implements strict A2A v1 behavior. v0.3 and direct-endpoint
behavior are available only from `@a2a-workbench/client/compat`. Strict connections
never downgrade or automatically invoke compatibility behavior.

The browser may present both profiles through one Protocol Lab workspace and
one explicit profile dropdown. That shared presentation boundary does not share
the underlying connection, run, validation, or evidence state.

## Consequences

Conformance results cannot be contaminated by legacy fallback. Consumers must make
a visible choice to use compatibility mode and receive results labeled as such.
