# A2A v1 client conformance — spec/TCK-derived

This report covers `@a2a-workbench/client@0.1.0` against A2A v1.0. It is a
client conformance report, not an A2A TCK certification. The TCK primarily
executes requests against an A2A server; its client-relevant requirement IDs and
scenarios are used here for traceability and deterministic contract tests.

The machine-readable source is
[`client-requirements.json`](./client-requirements.json). It pins the
specification, TCK, SDK, and schema revisions; maps each applicable client
requirement to C4 owners and executable tests; and records unsupported features.

Run the evidence gates with:

```bash
npm run conformance:check
npm run test
npm run package:smoke
```

## Release scope

Supported: strict A2A v1 discovery, JSON-RPC, HTTP+JSON, SSE, core message and
task lifecycle operations, signed and cached Agent Cards, supported noninteractive
credentials, typed errors, and redacted wire evidence.

Explicitly unsupported: gRPC, push-notification management, interactive
OAuth/OIDC, device authorization, and mutual TLS.

The scheduled and manually dispatchable
[Python interoperability workflow](../.github/workflows/a2a-interop.yml) runs
both supported bindings against `a2a-sdk[http-server]==1.1.0` and publishes its
report as a workflow artifact.
