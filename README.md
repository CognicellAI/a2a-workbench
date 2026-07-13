# A2A + A2UI Workbench

A local developer workbench for testing A2A `message:send` and `message:stream` endpoints, inspecting protocol traffic, and rendering A2UI surfaces with the official React v0.9 renderer.

The app is designed for protocol debugging: it keeps the raw A2A payloads visible, turns text parts into a readable chat transcript, and renders `application/a2ui+json` parts in a separate stage.

## Features

- A2A HTTP+JSON request construction with A2UI client capabilities.
- Support for both `message:send` JSON responses and `message:stream` SSE responses.
- M2M OAuth client credentials support.
- Per-run custom headers with secret redaction.
- Protocol inspector for request, raw frames, parsed A2A, A2UI envelopes, metadata, and errors.
- Local persistence for convenience settings only; secret values are not persisted.

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Defaults

The UI can provide connection values per run, but local defaults are supported. Start from [.env.example](./.env.example):

```bash
cp .env.example .env.local
```

```bash
A2A_UPSTREAM=https://agent.example.com/message:stream
A2A_A2UI_TRIGGER=[a2ui]
A2A_API_KEY=
A2A_SCOPE_HEADER=X-A2A-Scope-User
A2A_SCOPE_USER=

A2A_OAUTH_ENABLED=false
A2A_OAUTH_TOKEN_URL=
A2A_OAUTH_CLIENT_ID=
A2A_OAUTH_CLIENT_SECRET=
A2A_OAUTH_SCOPE=
A2A_OAUTH_AUDIENCE=
A2A_OAUTH_AUTH_METHOD=client_secret_basic

A2A_UPSTREAM_ALLOWLIST=
A2A_ALLOW_PRIVATE_NETWORKS=false
A2A_UPSTREAM_TIMEOUT_MS=120000
A2A_UPSTREAM_MAX_BYTES=10485760
```

M2M OAuth uses the OAuth 2.0 client credentials flow. When enabled, the server route exchanges the client credentials for an access token and forwards it as `Authorization: <token_type> <access_token>`, overriding any manual authorization header for that request.

## Security Model

This is a local workbench, not a hosted multi-tenant gateway.

The browser calls the local Next.js route at `/api/a2a/stream`; that route performs the upstream A2A request server-side so credentials do not need to be sent directly from the browser to arbitrary endpoints.

Default route guardrails:

- Blocks localhost, private-network, link-local, multicast, and metadata-service upstream targets.
- Supports `A2A_UPSTREAM_ALLOWLIST` for hosted or shared deployments.
- Uses `A2A_UPSTREAM_TIMEOUT_MS` and `A2A_UPSTREAM_MAX_BYTES` to cap upstream calls.
- Redacts secret-shaped keys and secret headers from inspector output.
- Does not persist secret header values or OAuth client secrets to `localStorage`.

If you intentionally need to test a private or localhost A2A endpoint, set:

```bash
A2A_ALLOW_PRIVATE_NETWORKS=true
```

Do not expose an instance with private-network access enabled unless it is protected by your own authentication, authorization, and network controls.

## Checks

```bash
npm run lint
npm run test
npm run typecheck
npm run build
```

## License

MIT
