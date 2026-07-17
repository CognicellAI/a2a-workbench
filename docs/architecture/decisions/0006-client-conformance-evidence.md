# ADR-006: Use Spec/TCK-Derived Client Conformance Evidence

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

Maintain a machine-readable registry of applicable v1 client requirements mapped
to architecture components and automated tests. Use deterministic contract agents
for pull requests and a pinned cross-language agent for scheduled interoperability.

## Consequences

Reports are reproducible and requirement based. They are labeled
**A2A v1 client conformance — spec/TCK-derived** and never imply TCK certification,
because the TCK's system under test is an A2A server.

