# ADR-005: Honor HTTP Caching and Verify Present Signatures

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

Agent Card discovery honors standard HTTP freshness and validators. Unsigned cards
are allowed. When signatures are present, at least one must validate against the
injected trust store before the card is selected or cached as usable.

## Consequences

Consumers can distinguish fresh, revalidated, stale-rejected, unsigned, and
verified cards. Signed but unverifiable cards fail closed.

