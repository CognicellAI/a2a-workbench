# ADR-004: Support JSON-RPC and HTTP+JSON First

**Status:** Accepted  
**Date:** 2026-07-16

## Decision

The first conformant release supports the A2A v1 `JSONRPC` and `HTTP+JSON`
bindings. It follows Agent Card preference order and skips unsupported gRPC or
custom interfaces. No supported match is a typed connection failure.

## Consequences

Both HTTP bindings must pass the same lifecycle contract suite. gRPC is explicitly
reported as unsupported rather than emulated or silently reordered.

