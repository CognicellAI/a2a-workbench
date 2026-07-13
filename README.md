# A2A + A2UI Workbench

CognicellAI-branded local workbench for testing A2A `message/stream` traffic and rendering A2UI output with the official React v0.9 renderer.

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Optional Environment Defaults

The UI can provide these per run, but local defaults are supported:

```bash
A2A_UPSTREAM=https://agent.example.com/a2a
A2A_API_KEY=...
A2A_SCOPE_HEADER=X-A2A-Scope-User
A2A_SCOPE_USER=operator@example.com
A2A_A2UI_TRIGGER=[a2ui]
A2A_OAUTH_ENABLED=false
A2A_OAUTH_TOKEN_URL=https://issuer.example.com/oauth/token
A2A_OAUTH_CLIENT_ID=...
A2A_OAUTH_CLIENT_SECRET=...
A2A_OAUTH_SCOPE=a2a:stream
A2A_OAUTH_AUDIENCE=https://agent.example.com
A2A_OAUTH_AUTH_METHOD=client_secret_basic
```

M2M OAuth uses the OAuth 2.0 client credentials flow. When enabled, the server route exchanges the client credentials for an access token and forwards it as `Authorization: <token_type> <access_token>`, overriding any manual authorization header for that request.

Secret header values and OAuth secrets are forwarded by the server route, redacted in inspector output, and not persisted to `localStorage`.

## Checks

```bash
npm run lint
npm run test
npm run typecheck
npm run build
```
