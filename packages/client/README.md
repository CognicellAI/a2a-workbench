# @a2a-workbench/client

Strict A2A v1 client core used by A2A Workbench. The package supports the
`JSONRPC` and `HTTP+JSON` bindings on Node.js 20+. It is ESM-only and independent
of React and Next.js.

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

The connected client also exposes `refreshAgentCard`, `getExtendedAgentCard`,
`sendStreamingMessage`, `getTask`, `listTasks`, `cancelTask`, and
`subscribeToTask`. Connection metadata reports the exact selected interface,
protocol version, tenant, extensions, security requirement, cache state, and
signature trust state.

Hosts may inject credential providers, Agent Card caches, signature trust stores,
URL policy, `fetch`, clocks, abort signals, and evidence sinks. The built-in
static credential provider supports header API keys, Basic, Bearer, OAuth2 client
credentials, and explicit custom headers.

Compatibility behavior is never automatic. Import it explicitly:

```ts
import { connectLegacyClient } from "@a2a-workbench/client/compat";
```

Compatibility results are outside strict v1 conformance evidence. The package
does not support gRPC, push-notification management, interactive OAuth/OIDC, or
mutual TLS in v0.1.x.

See the source repository's protocol contract for discovery, authentication,
trust, caching, lifecycle, and error semantics.
