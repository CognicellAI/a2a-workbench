# A2A Workbench Target Architecture

**Status:** Normative target  
**Audience:** Client-library maintainers, workbench contributors, security reviewers  
**Protocol baseline:** A2A v1.0  
**Last reviewed:** 2026-07-16

This documentation is the source of truth for the target A2A Workbench
architecture. The system provides a strict A2A v1 client library and a human
workbench built on that same public API.

## Documentation map

- [System C4 model](./c4-model.md) defines the system context, runtime
  containers, client and BFF components, deployment topology, and protocol
  flows.
- [Frontend design architecture and C4 model](./frontend-c4-model.md) defines
  the browser component model, interaction workspaces, state ownership,
  responsive behavior, and accessibility rules.
- [Protocol contract](./protocol-contract.md) defines the public API, data model,
  binding behavior, security model, errors, evidence, and conformance policy.
- [Architecture decisions](./decisions/README.md) records the decisions that
  constrain implementation choices.
- [Client conformance report](../../conformance/README.md) maps the pinned
  protocol baseline to architecture owners and executable evidence.

## Goals

- Conform to the normative A2A v1 client requirements for discovery, protocol
  selection, versioning, authentication, task lifecycle, and streaming.
- Offer one reusable, publication-ready Node.js client API and use that API from
  the workbench rather than maintaining a separate protocol implementation.
- Make every protocol decision and wire exchange inspectable without exposing
  credentials.
- Keep legacy v0.3 and direct-endpoint workflows available only through an
  explicit compatibility boundary.
- Produce evidence-backed conformance reports without claiming certification by
  a server-focused test suite.

## Non-goals for the first conformant release

- gRPC transport
- Push-notification configuration or callback hosting
- Interactive OAuth, OpenID Connect, device authorization, or mutual TLS
- Browser-direct A2A requests
- Persistent credential storage
- TCK certification claims

## Quality attributes

| Attribute | Target |
| --- | --- |
| Conformance | Every applicable client `MUST` maps to an architecture owner and automated test. |
| Security | Remote traffic runs through a host policy boundary; secrets are never persisted or emitted as evidence. |
| Interoperability | JSON-RPC and HTTP+JSON provide equivalent lifecycle behavior and share normalized results. |
| Testability | Fetch, time, cache, trust, credentials, URL policy, and evidence are injectable. |
| Evolvability | Wire validators accept unknown fields while validating every known v1 invariant. |
| Operability | Selected interface, version, tenant, extensions, authentication, cache, and signature state are observable. |
| Portability | The client package is ESM-only, requires Node.js 20+, and has no React or Next.js dependency. |

## Architecture rules

1. `@a2a-workbench/client` is the only strict A2A protocol implementation used by
   the workbench.
2. Strict v1 exports and compatibility exports never share an automatic fallback
   path.
3. Untrusted network data is validated before it becomes a domain value.
4. Agent Card interface order is authoritative; the first supported declared
   interface is selected with its exact URL, version, and tenant.
5. The package enforces protocol policy. The embedding host additionally enforces
   deployment policy such as SSRF protection, redirect rules, and byte limits.
6. Evidence is recorded at the transport boundary after recursive redaction.
7. Extension behavior is enabled only when declared by the Agent Card and
   requested by the client.
8. No workbench module imports private client-package files.

## Normative sources

| Source | Pinned baseline | Use |
| --- | --- | --- |
| [A2A specification](https://a2a-protocol.org/v1.0.0/specification/) | v1.0.0, source commit `173695755607e884aa9acf8ce4feed90e32727a1` | Normative requirements and wire semantics |
| [A2A TCK](https://github.com/a2aproject/a2a-tck) | `5996b79f9cefa6fc390980e383e358a66fb9e49e` | Requirement identifiers and interoperability scenarios |
| [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) | `@a2a-js/sdk@1.0.0-beta.0` | Transport implementation behind the workbench façade |

The implementation records these revisions in its machine-readable conformance
manifest. Updating a source requires an architecture review and a new decision
record when behavior changes.

## Terminology

- **Agent Card:** Public metadata document used to discover an agent's interfaces,
  capabilities, extensions, and security requirements.
- **Binding:** Mapping of A2A operations to a transport. This release supports
  `JSONRPC` and `HTTP+JSON`.
- **Compatibility mode:** Explicit v0.3 or direct-endpoint behavior imported from
  a separate package subpath.
- **Evidence:** Redacted request, response, stream, and decision metadata exposed
  to callers and the protocol inspector.
- **Host policy:** Network and deployment restrictions supplied by the application
  embedding the client.
- **Strict mode:** A2A v1 behavior that fails closed instead of downgrading.
