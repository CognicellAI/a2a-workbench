# A2A Workbench

A protocol workbench and reusable Node.js client for strict A2A v1 discovery,
message exchange, task lifecycle operations, streaming, and redacted wire
evidence. The browser UI consumes the same public `@a2a-workbench/client` API
available to external Node.js applications.

Maintained by [CognicellAI](https://cognicellai.com/). Created by [Herman
Haggerty](https://github.com/dubh3124).

## Baseline

- Strict A2A v1 is the default and never silently downgrades.
- Agent Cards drive ordered interface selection for JSON-RPC or HTTP+JSON.
- Send, stream, get, list, cancel, subscribe, and extended Agent Card operations.
- Agent Card validation, HTTP caching, optional trusted JWS verification, and
  capability/extension negotiation.
- Header API keys, Basic/Bearer credentials, OAuth2 client credentials, and an
  explicit custom-header provider.
- Per-request version, tenant, extension, correlation, schema, semantic, SSE,
  URL, timeout, redirect, and response-size enforcement.
- Binding-aware request, response, and SSE evidence with recursive credential
  redaction.
- Explicit v0.3/direct-endpoint compatibility mode, isolated from strict
  conformance results.

The first release does not support gRPC, push-notification management,
interactive OAuth/OIDC, device authorization, or mutual TLS.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Strict mode accepts an agent
origin such as `https://agent.example.com` or a full Agent Card URL. Direct
operation endpoints belong only in compatibility mode.

## Run with Docker

Build and start the workbench with Docker Compose:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). To configure optional
upstream defaults or credentials, copy `.env.example` to `.env` before starting.
Do not enable `A2A_ALLOW_PRIVATE_NETWORKS` on a shared or internet-facing host.

For a direct Docker command:

```bash
docker build -t a2a-workbench .
docker run --rm -p 3000:3000 a2a-workbench
```

Add `--env-file .env` if you created a local environment file.

The image runs as an unprivileged user and uses Next.js standalone output. Put a
reverse proxy with TLS, request limits, and rate limiting in front of it when
exposing it publicly.

## Reusable client

```ts
import { connectA2aClient } from "@a2a-workbench/client";

const client = await connectA2aClient({
  agentUrl: "https://agent.example.com",
});

const result = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text: "Hello" }],
  },
});
```

The package is ESM-only, targets Node.js 20+, and has no React or Next.js
dependency. See the [package guide](./packages/client/README.md) and
[protocol contract](./docs/architecture/protocol-contract.md).

## Environment defaults

Start from [.env.example](./.env.example):

```bash
cp .env.example .env.local
```

`A2A_UPSTREAM` is an agent origin or Agent Card URL in strict mode.
`A2A_A2UI_TRIGGER` applies only to compatibility extraction. Strict A2UI is
enabled only when the Agent Card and client negotiate the A2UI extension.

The server/BFF rejects unsafe network targets, cross-origin redirects, insecure
production URLs, timeouts, and oversized responses. Private/localhost testing
requires `A2A_ALLOW_PRIVATE_NETWORKS=true`; do not enable it on an unprotected
shared deployment. See [SECURITY.md](./SECURITY.md).

## Architecture and conformance

- [Target architecture and C4 views](./docs/architecture/README.md)
- [Accepted architecture decisions](./docs/architecture/decisions/README.md)
- [A2A v1 client conformance — spec/TCK-derived](./conformance/README.md)

The TCK is used for requirement traceability and interoperability scenarios; the
project does not claim server-oriented TCK certification.

```bash
npm run check
npm run build
```

Cross-language verification uses the pinned official Python A2A SDK fixture:

```bash
python -m pip install -r conformance/interop/python-requirements.txt
npm run build:client
npm run interop:python
```

## Contributors

[Herman Haggerty](https://github.com/dubh3124) is the creator and maintainer.
See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute.

## License

MIT
