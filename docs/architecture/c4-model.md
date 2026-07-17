# C4 Model

**Audience:** Maintainers and architecture reviewers  
**Model:** Target architecture only  
**Notation:** Mermaid flowcharts using C4 scopes and stable element identifiers

The published client is a reusable code boundary, not a separately running
service. It is therefore shown inside each Node.js host that embeds it.

## C1: System context

```mermaid
flowchart LR
  ACT_OPERATOR["ACT-OPERATOR<br/>Workbench operator"]
  ACT_CONSUMER["ACT-CONSUMER<br/>Client package consumer"]
  SYS_WORKBENCH["SYS-WORKBENCH<br/>A2A Workbench<br/>Strict client library and protocol UI"]
  EXT_HOST["EXT-HOST<br/>Consumer Node.js application"]
  EXT_AGENT["EXT-AGENT<br/>Remote A2A agent"]
  EXT_AUTH["EXT-AUTH<br/>Authorization server"]
  EXT_TRUST["EXT-TRUST<br/>JWS/JWKS trust provider"]

  ACT_OPERATOR -->|discovers, invokes, and inspects| SYS_WORKBENCH
  ACT_CONSUMER -->|embeds client package in| EXT_HOST
  EXT_HOST -->|uses the published client API| SYS_WORKBENCH
  SYS_WORKBENCH -->|discovers and invokes A2A v1| EXT_AGENT
  SYS_WORKBENCH -->|obtains client-credential tokens| EXT_AUTH
  SYS_WORKBENCH -->|resolves trusted verification keys| EXT_TRUST
```

## C2: Runtime containers

```mermaid
flowchart LR
  ACT_OPERATOR["ACT-OPERATOR<br/>Operator"]
  subgraph SYS_WORKBENCH["SYS-WORKBENCH — A2A Workbench"]
    CTR_BROWSER["CTR-BROWSER<br/>Browser workbench<br/>React 19"]
    CTR_SERVER["CTR-SERVER<br/>Workbench BFF<br/>Next.js route handlers / Node.js"]
    LIB_CLIENT_A["LIB-CLIENT<br/>@a2a-workbench/client<br/>Embedded ESM library"]
  end
  subgraph EXT_HOST["EXT-HOST — Consumer application"]
    CTR_HOST["CTR-HOST<br/>Node.js 20+ host"]
    LIB_CLIENT_B["LIB-CLIENT<br/>@a2a-workbench/client<br/>Embedded ESM library"]
  end
  EXT_AGENT["EXT-AGENT<br/>A2A server"]
  EXT_AUTH["EXT-AUTH<br/>OAuth authorization server"]
  EXT_TRUST["EXT-TRUST<br/>JWK/JWKS source"]

  ACT_OPERATOR -->|HTTPS / same origin| CTR_BROWSER
  CTR_BROWSER -->|validated commands and ephemeral credentials| CTR_SERVER
  CTR_SERVER --> LIB_CLIENT_A
  CTR_HOST --> LIB_CLIENT_B
  LIB_CLIENT_A -->|Agent Card, JSON-RPC, HTTP+JSON, SSE| EXT_AGENT
  LIB_CLIENT_B -->|Agent Card, JSON-RPC, HTTP+JSON, SSE| EXT_AGENT
  LIB_CLIENT_A -->|OAuth2 client credentials| EXT_AUTH
  LIB_CLIENT_B -->|OAuth2 client credentials| EXT_AUTH
  LIB_CLIENT_A -->|signature key lookup| EXT_TRUST
  LIB_CLIENT_B -->|signature key lookup| EXT_TRUST
```

## C3: Client package

```mermaid
flowchart TB
  CMP_FACADE["CMP-FACADE<br/>Connection and lifecycle façade"]
  CMP_CARD["CMP-CARD<br/>Agent Card resolver"]
  CMP_CACHE["CMP-CACHE<br/>HTTP-aware card cache"]
  CMP_VALIDATOR["CMP-VALIDATOR<br/>Schema and semantic validation"]
  CMP_SIGNATURE["CMP-SIGNATURE<br/>Card signature verification"]
  CMP_NEGOTIATOR["CMP-NEGOTIATOR<br/>Interface, capability, extension, auth selection"]
  CMP_CREDENTIALS["CMP-CREDENTIALS<br/>Credential providers"]
  CMP_TRANSPORT["CMP-TRANSPORT<br/>Pinned SDK transport façade"]
  CMP_STREAM["CMP-STREAM<br/>Validated SSE pipeline"]
  CMP_EVIDENCE["CMP-EVIDENCE<br/>Redacted evidence sink"]
  CMP_COMPAT["CMP-COMPAT<br/>Explicit v0.3/direct adapter"]
  EXT_AGENT["EXT-AGENT<br/>Remote A2A agent"]
  EXT_AUTH["EXT-AUTH<br/>Authorization server"]
  EXT_TRUST["EXT-TRUST<br/>Trust provider"]

  CMP_FACADE --> CMP_CARD
  CMP_CARD <--> CMP_CACHE
  CMP_CARD --> CMP_VALIDATOR
  CMP_CARD --> CMP_SIGNATURE
  CMP_SIGNATURE --> EXT_TRUST
  CMP_FACADE --> CMP_NEGOTIATOR
  CMP_NEGOTIATOR --> CMP_CREDENTIALS
  CMP_CREDENTIALS --> EXT_AUTH
  CMP_FACADE --> CMP_TRANSPORT
  CMP_TRANSPORT --> CMP_STREAM
  CMP_TRANSPORT --> EXT_AGENT
  CMP_CARD --> EXT_AGENT
  CMP_CARD --> CMP_EVIDENCE
  CMP_TRANSPORT --> CMP_EVIDENCE
  CMP_STREAM --> CMP_VALIDATOR
  CMP_STREAM --> CMP_EVIDENCE
  CMP_COMPAT -. separate package export .-> CMP_TRANSPORT
```

## Frontend component model

The target browser component model, interaction workspaces, state ownership,
responsive behavior, and accessibility rules are maintained in the separate
[frontend design architecture and C4 model](./frontend-c4-model.md). This system
view retains the `CTR-BROWSER` container boundary without duplicating frontend
component definitions.

## Dynamic view: strict discovery and authentication

```mermaid
sequenceDiagram
  participant UI as CTR-BROWSER
  participant BFF as CMP-ROUTE
  participant Card as CMP-CARD
  participant Cache as CMP-CACHE
  participant Agent as EXT-AGENT
  participant Verify as CMP-SIGNATURE
  participant Trust as EXT-TRUST
  participant Negotiate as CMP-NEGOTIATOR
  participant Auth as CMP-CREDENTIALS

  UI->>BFF: Connect(agent origin, credential references)
  BFF->>Card: Resolve /.well-known/agent-card.json
  Card->>Cache: Read cache metadata
  Card->>Agent: GET card with validators and A2A-Version: 1.0
  Agent-->>Card: Agent Card or 304
  Card->>Card: Validate schema and semantics
  Card->>Verify: Verify signatures when present
  Verify->>Trust: Resolve trusted key
  Trust-->>Verify: Verification material
  Card->>Negotiate: Ordered supportedInterfaces
  Negotiate->>Auth: Select first satisfiable security alternative
  Negotiate-->>BFF: Connection metadata
  BFF-->>UI: Selected binding, URL, tenant, trust, cache, auth
```

## Dynamic view: send streaming message

```mermaid
sequenceDiagram
  participant UI as CTR-BROWSER
  participant Route as CMP-ROUTE
  participant Client as CMP-FACADE
  participant Transport as CMP-TRANSPORT
  participant Agent as EXT-AGENT
  participant Stream as CMP-STREAM
  participant Evidence as CMP-EVIDENCE

  UI->>Route: sendStreamingMessage(command)
  Route->>Client: sendStreamingMessage(validated request)
  Client->>Client: Check streaming capability
  Client->>Transport: Exact interface + tenant + version + extensions
  Transport->>Evidence: Redacted outbound exchange
  Transport->>Agent: JSON-RPC or POST /message:stream
  Agent-->>Stream: SSE frames
  Stream->>Stream: Decode and validate each event
  Stream->>Evidence: Redacted inbound event
  Stream-->>Route: Typed StreamResponse
  Route-->>UI: Workbench SSE evidence and result events
```

## Dynamic view: task subscription and cancellation

```mermaid
sequenceDiagram
  participant UI as CTR-BROWSER
  participant Client as CMP-FACADE
  participant Agent as EXT-AGENT

  UI->>Client: subscribeToTask(task id)
  Client->>Agent: SubscribeToTask / tasks/{id}:subscribe
  Agent-->>Client: Task as first event
  Agent-->>Client: Ordered status/artifact events
  alt operator cancels a cancelable task
    UI->>Client: cancelTask(task id)
    Client->>Agent: CancelTask / tasks/{id}:cancel
    Agent-->>Client: Canceled Task
  else terminal event arrives
    Agent-->>Client: Terminal update and stream close
  end
```

## Dynamic view: compatibility mode

```mermaid
sequenceDiagram
  participant Host as CTR-SERVER
  participant Compat as CMP-COMPAT
  participant Legacy as EXT-AGENT

  Host->>Compat: Explicit connectLegacyClient(...)
  Note over Host,Compat: Root strict API is not involved
  Compat->>Legacy: v0.3 discovery or direct endpoint request
  Legacy-->>Compat: Legacy response or SSE
  Compat-->>Host: Compatibility result marked non-conformant
```

## Deployment and trust boundaries

```mermaid
flowchart LR
  subgraph USER_DEVICE["Operator trust zone"]
    CTR_BROWSER["CTR-BROWSER<br/>Ephemeral form state"]
  end
  subgraph APP_RUNTIME["Workbench server trust zone"]
    CTR_SERVER["CTR-SERVER<br/>Node.js process"]
    CMP_NETWORK["CMP-NETWORK<br/>SSRF, redirect, timeout, byte policy"]
    LIB_CLIENT["LIB-CLIENT<br/>Protocol and redaction policy"]
  end
  subgraph REMOTE["Untrusted remote network"]
    EXT_AGENT["EXT-AGENT"]
    EXT_AUTH["EXT-AUTH"]
    EXT_TRUST["EXT-TRUST"]
  end

  CTR_BROWSER -->|same-origin TLS; secrets in request scope| CTR_SERVER
  CTR_SERVER --> CMP_NETWORK --> LIB_CLIENT
  LIB_CLIENT -->|HTTPS only except explicit localhost development| EXT_AGENT
  LIB_CLIENT -->|HTTPS| EXT_AUTH
  LIB_CLIENT -->|HTTPS| EXT_TRUST
```

## Element catalog

| ID | Kind | Responsibility |
| --- | --- | --- |
| `ACT-OPERATOR` | Person | Exercises agents and inspects protocol evidence. |
| `ACT-CONSUMER` | Person | Embeds the reusable client in another Node.js application. |
| `SYS-WORKBENCH` | Software system | Provides the strict client library and protocol workbench. |
| `CTR-BROWSER` | Container | Captures commands and renders typed results and redacted evidence. |
| `CTR-SERVER` | Container | Applies host policy and adapts the client API to browser SSE. |
| `CTR-HOST` | Container | Represents an external application embedding the client library. |
| `LIB-CLIENT` | Library boundary | Exposes the publication-ready strict and compatibility APIs. |
| `CMP-FACADE` | Component | Owns a connected Agent Card, interface, and lifecycle operations. |
| `CMP-CARD` | Component | Discovers and refreshes Agent Cards. |
| `CMP-CACHE` | Component | Applies HTTP freshness and conditional-request semantics. |
| `CMP-VALIDATOR` | Component | Validates known schema and semantic invariants. |
| `CMP-SIGNATURE` | Component | Verifies at least one trusted signature when signatures exist. |
| `CMP-NEGOTIATOR` | Component | Selects binding, capabilities, extensions, and satisfiable auth. |
| `CMP-CREDENTIALS` | Component | Supplies API-key, HTTP, OAuth2, or explicit custom credentials. |
| `CMP-TRANSPORT` | Component | Wraps the pinned SDK and enforces the selected interface. |
| `CMP-STREAM` | Component | Decodes, validates, orders, and aborts SSE delivery. |
| `CMP-EVIDENCE` | Component | Emits bounded, recursively redacted protocol evidence. |
| `CMP-COMPAT` | Component | Implements explicitly selected v0.3/direct-endpoint behavior. |
| `CMP-ROUTE` | Component | Converts browser commands to public client calls and back to SSE. |
| `CMP-NETWORK` | Component | Enforces SSRF, redirect, timeout, abort, and response-size policy. |
| `EXT-AGENT` | External system | Publishes an Agent Card and serves A2A operations. |
| `EXT-AUTH` | External system | Issues OAuth2 client-credential access tokens. |
| `EXT-TRUST` | External system | Supplies trusted keys for Agent Card signature verification. |
| `EXT-HOST` | External system | Uses the package without depending on the workbench UI. |
