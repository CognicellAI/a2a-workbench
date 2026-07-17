import { generateAgentCardSignature } from "@a2a-js/sdk";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  MemoryAgentCardCache,
  connectA2aClient,
  createStaticCredentialProvider,
  type AgentCard,
  type SendMessageRequest,
  type SupportedBinding,
} from "./index.js";

const task = {
  id: "task-1",
  contextId: "context-1",
  status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-07-16T12:00:00Z" },
  artifacts: [],
  history: [],
};

const request: SendMessageRequest = {
  message: {
    messageId: "message-1",
    role: "ROLE_USER",
    parts: [{ text: "Hello" }],
  },
  configuration: { acceptedOutputModes: ["text/plain"] },
};

describe.each(["JSONRPC", "HTTP+JSON"] as const)("strict %s binding", (binding) => {
  it("supports discovery and the core task lifecycle", async () => {
    const agent = mockAgent(binding, { tenant: "tenant-a" });
    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      requestedExtensions: ["https://example.com/a2ui/v0.9"],
    });

    expect(client.connection.selectedInterface.protocolBinding).toBe(binding);
    expect(client.connection.selectedInterface.tenant).toBe("tenant-a");
    expect(client.connection.negotiatedExtensions).toEqual(["https://example.com/a2ui/v0.9"]);
    expect(agent.requests[0]?.headers.get("a2a-version")).toBe("1.0");

    await expect(client.sendMessage(request)).resolves.toMatchObject({ id: "task-1" });
    const streamed = [];
    for await (const event of client.sendStreamingMessage(request)) streamed.push(event);
    expect(streamed).toHaveLength(2);
    await expect(client.getTask({ id: "task-1" })).resolves.toMatchObject({ id: "task-1" });
    await expect(client.listTasks({ pageSize: 10 })).resolves.toMatchObject({ totalSize: 1 });
    await expect(client.cancelTask({ id: "task-1" })).resolves.toMatchObject({ id: "task-1" });
    const subscribed = [];
    for await (const event of client.subscribeToTask({ id: "task-1" })) subscribed.push(event);
    expect(subscribed[0]).toHaveProperty("task.id", "task-1");

    const operationRequests = agent.requests.filter((item) => !item.url.includes("agent-card.json"));
    expect(operationRequests.every((item) => item.headers.get("a2a-version") === "1.0")).toBe(true);
    expect(operationRequests.every((item) => item.headers.get("a2a-extensions") === "https://example.com/a2ui/v0.9")).toBe(true);
    if (binding === "HTTP+JSON") {
      expect(operationRequests.some((item) => item.url.includes("/tenant-a/message:send"))).toBe(true);
      expect(operationRequests.some((item) => item.url.includes("/tenant-a/tasks/task-1:subscribe"))).toBe(true);
    } else {
      const bodies = operationRequests.map((item) => item.body).filter(isRecord);
      expect(bodies.every((body) => isRecord(body.params) && body.params.tenant === "tenant-a")).toBe(true);
    }
  });

  it("maps protocol task errors to stable client errors", async () => {
    const agent = mockAgent(binding, { taskNotFound: true });
    const client = await connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch });
    await expect(client.getTask({ id: "missing-task" })).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      operation: "getTask",
    });
  });
});

describe("strict discovery and policy", () => {
  it("selects the first supported interface in declared order", async () => {
    const card = validCard("HTTP+JSON");
    card.supportedInterfaces = [
      { url: "https://agent.example/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
      { url: "https://agent.example/rest-first", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      { url: "https://agent.example/rpc-second", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ];
    const agent = mockAgent("HTTP+JSON", { card });
    const client = await connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch });
    expect(client.connection.selectedInterface.url).toBe("https://agent.example/rest-first");
  });

  it("rejects cards without a supported v1 HTTP binding", async () => {
    const card = validCard("HTTP+JSON");
    card.supportedInterfaces = [
      { url: "https://agent.example/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
      { url: "https://agent.example/legacy", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ];
    const agent = mockAgent("HTTP+JSON", { card });
    await expect(connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_TRANSPORT" });
  });

  it("ignores patch versions during v1 protocol negotiation", async () => {
    const card = validCard("HTTP+JSON");
    card.supportedInterfaces = [{
      url: "https://agent.example/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0.7",
    }];
    const agent = mockAgent("HTTP+JSON", { card });
    const client = await connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch });
    expect(client.connection.protocolVersion).toBe("1.0");
    expect(client.connection.selectedInterface.protocolVersion).toBe("1.0.7");
  });

  it("fails closed when the Agent Card requires an unrequested extension", async () => {
    const card = validCard("HTTP+JSON");
    card.capabilities = {
      ...card.capabilities,
      extensions: [{ uri: "https://example.com/required/v1", required: true }],
    };
    const agent = mockAgent("HTTP+JSON", { card });
    await expect(connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
  });

  it("rejects insecure production URLs and cross-origin redirects", async () => {
    await expect(connectA2aClient({ agentUrl: "http://agent.example" }))
      .rejects.toMatchObject({ code: "URL_POLICY_REJECTED" });

    const redirectingFetch: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { Location: "https://other.example/card.json" } });
    await expect(connectA2aClient({ agentUrl: "https://agent.example", fetch: redirectingFetch }))
      .rejects.toMatchObject({ code: "URL_POLICY_REJECTED" });
  });

  it("honors fresh card caching and conditional revalidation", async () => {
    const cache = new MemoryAgentCardCache();
    let now = 1_000_000;
    let discoveryCount = 0;
    const agent = mockAgent("HTTP+JSON", {
      cardHeaders: { "Cache-Control": "max-age=60", ETag: '"card-1"' },
      onDiscovery(request) {
        discoveryCount += 1;
        if (request.headers.get("if-none-match") === '"card-1"') {
          return new Response(null, { status: 304, headers: { "Cache-Control": "max-age=60" } });
        }
      },
    });
    const base = { agentUrl: "https://agent.example", fetch: agent.fetch, cache, clock: { now: () => now } };
    await connectA2aClient(base);
    await connectA2aClient(base);
    expect(discoveryCount).toBe(1);
    now += 61_000;
    const revalidated = await connectA2aClient(base);
    expect(discoveryCount).toBe(2);
    expect(revalidated.connection.cache).toBe("revalidated");
  });

  it("verifies present signatures and rejects signed cards without trust", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const signer = generateAgentCardSignature(privateKey, { alg: "ES256", kid: "test-key", typ: "JOSE" });
    const signed = await signer(validCard("HTTP+JSON") as never);
    const signedCard = signed as unknown as AgentCard;
    const agent = mockAgent("HTTP+JSON", { card: signedCard as MutableAgentCard });

    await expect(connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch }))
      .rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED" });

    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      signatureTrustStore: { resolve: async () => publicKey },
    });
    expect(client.connection.trust).toBe("verified");

    await expect(connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      signatureTrustStore: { resolve: async () => { throw new Error("key expired"); } },
    })).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED" });
  });

  it("applies the first satisfiable security requirement", async () => {
    const card = validCard("HTTP+JSON");
    card.securitySchemes = {
      api: { apiKeySecurityScheme: { location: "header", name: "X-Agent-Key" } },
    };
    card.securityRequirements = [{ schemes: { api: { list: [] } } }];
    const agent = mockAgent("HTTP+JSON", { card });
    const provider = createStaticCredentialProvider({ api: { type: "apiKey", value: "secret-value" } });
    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      credentialProvider: provider,
    });
    await client.sendMessage(request);
    const operation = agent.requests.find((item) => item.url.includes("message:send"));
    expect(operation?.headers.get("x-agent-key")).toBe("secret-value");
  });

  it("supports Basic, Bearer, and explicit custom-header credentials", async () => {
    const cases = [
      {
        scheme: { httpAuthSecurityScheme: { scheme: "basic" } },
        credential: { type: "basic", username: "client", password: "password" } as const,
        header: "authorization",
        expected: `Basic ${Buffer.from("client:password").toString("base64")}`,
      },
      {
        scheme: { httpAuthSecurityScheme: { scheme: "bearer" } },
        credential: { type: "bearer", token: "bearer-token" } as const,
        header: "authorization",
        expected: "Bearer bearer-token",
      },
      {
        scheme: { apiKeySecurityScheme: { location: "header", name: "X-Declared-Key" } },
        credential: { type: "customHeaders", headers: { "X-Custom-Credential": "custom-value" } } as const,
        header: "x-custom-credential",
        expected: "custom-value",
      },
    ] as const;
    for (const item of cases) {
      const card = validCard("HTTP+JSON");
      card.securitySchemes = { auth: item.scheme };
      card.securityRequirements = [{ schemes: { auth: { list: [] } } }];
      const agent = mockAgent("HTTP+JSON", { card });
      const client = await connectA2aClient({
        agentUrl: "https://agent.example",
        fetch: agent.fetch,
        credentialProvider: createStaticCredentialProvider({ auth: item.credential }),
      });
      await client.sendMessage(request);
      const operation = agent.requests.find((entry) => entry.url.includes("message:send"));
      expect(operation?.headers.get(item.header)).toBe(item.expected);
    }
  });

  it("preserves security requirement OR alternatives and AND groups", async () => {
    const card = validCard("HTTP+JSON");
    card.securitySchemes = {
      api: { apiKeySecurityScheme: { location: "header", name: "X-Agent-Key" } },
      bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
    };
    card.securityRequirements = [
      { schemes: { api: { list: [] }, bearer: { list: [] } } },
      { schemes: { bearer: { list: [] } } },
    ];
    const agent = mockAgent("HTTP+JSON", { card });
    const provider = createStaticCredentialProvider({ bearer: { type: "bearer", token: "bearer-token" } });
    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      credentialProvider: provider,
    });
    expect(client.connection.securityRequirement).toEqual(card.securityRequirements[1]);
    await client.getExtendedAgentCard();
    const operation = agent.requests.find((item) => item.url.includes("extendedAgentCard"));
    expect(operation?.headers.get("authorization")).toBe("Bearer bearer-token");
  });

  it("obtains and caches OAuth2 client-credentials tokens", async () => {
    const card = validCard("HTTP+JSON");
    card.securitySchemes = {
      oauth: {
        oauth2SecurityScheme: {
          flows: { clientCredentials: { tokenUrl: "https://auth.example/token", scopes: { read: "Read" } } },
        },
      },
    };
    card.securityRequirements = [{ schemes: { oauth: { list: ["read"] } } }];
    const agent = mockAgent("HTTP+JSON", { card });
    const tokenRequests: Request[] = [];
    const provider = createStaticCredentialProvider({
      oauth: {
        type: "oauth2ClientCredentials",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    }, {
      fetch: async (input, init) => {
        tokenRequests.push(new Request(input, init));
        return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 300 });
      },
    });
    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      credentialProvider: provider,
    });
    await client.sendMessage(request);
    await client.getTask({ id: "task-1" });
    expect(tokenRequests).toHaveLength(1);
    expect(await tokenRequests[0]?.clone().text()).toContain("scope=read");
    expect(tokenRequests[0]?.headers.get("authorization")).toMatch(/^Basic /);
    const operation = agent.requests.find((item) => item.url.includes("message:send"));
    expect(operation?.headers.get("authorization")).toBe("Bearer access-token");
  });

  it("validates fragmented SSE events and recursively redacts evidence", async () => {
    const card = validCard("HTTP+JSON");
    card.securitySchemes = {
      api: { apiKeySecurityScheme: { location: "header", name: "X-Agent-Key" } },
    };
    card.securityRequirements = [{ schemes: { api: { list: [] } } }];
    const agent = mockAgent("HTTP+JSON", {
      card,
      fragmentSse: true,
      taskOverride: { ...task, futureWireField: { retained: true } },
    });
    const evidence: unknown[] = [];
    const client = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      credentialProvider: createStaticCredentialProvider({ api: { type: "apiKey", value: "secret-value" } }),
      evidenceSink: { emit: (event) => { evidence.push(event); } },
    });
    const events = [];
    for await (const event of client.sendStreamingMessage(request)) events.push(event);
    expect(events).toHaveLength(2);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("futureWireField");
  });

  it("rejects undeclared streaming and malformed individual SSE events", async () => {
    const nonStreamingCard = validCard("HTTP+JSON");
    nonStreamingCard.capabilities = { ...nonStreamingCard.capabilities, streaming: false };
    const nonStreamingAgent = mockAgent("HTTP+JSON", { card: nonStreamingCard });
    const nonStreamingClient = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: nonStreamingAgent.fetch,
    });
    await expect(collect(nonStreamingClient.sendStreamingMessage(request)))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });

    const malformedAgent = mockAgent("HTTP+JSON", {
      streamEvents: [{
        task,
        message: { messageId: "invalid", role: "ROLE_AGENT", parts: [{ text: "two payloads" }] },
      }],
    });
    const malformedClient = await connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: malformedAgent.fetch,
    });
    await expect(collect(malformedClient.sendStreamingMessage(request)))
      .rejects.toMatchObject({ code: "STREAM_INVALID" });
  });

  it("rejects unsupported interactive authentication", async () => {
    const card = validCard("HTTP+JSON");
    card.securitySchemes = {
      oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: "https://identity.example/.well-known/openid-configuration" } },
    };
    card.securityRequirements = [{ schemes: { oidc: { list: [] } } }];
    const agent = mockAgent("HTTP+JSON", { card });
    const customProvider = createStaticCredentialProvider({
      oidc: { type: "customHeaders", headers: { Authorization: "Bearer interactive-token" } },
    });
    await expect(connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: agent.fetch,
      credentialProvider: customProvider,
    }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_AUTHENTICATION" });
  });

  it("rejects non-UTC timestamps and mismatched message identifiers", async () => {
    const invalidTimestampTask = {
      ...task,
      status: { ...task.status, timestamp: "2026-07-16T13:00:00+01:00" },
    };
    const timestampAgent = mockAgent("HTTP+JSON", { taskOverride: invalidTimestampTask });
    const timestampClient = await connectA2aClient({ agentUrl: "https://agent.example", fetch: timestampAgent.fetch });
    await expect(timestampClient.getTask({ id: "task-1" }))
      .rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });

    const mismatchAgent = mockAgent("HTTP+JSON", { taskOverride: { ...task, id: "other-task" } });
    const mismatchClient = await connectA2aClient({ agentUrl: "https://agent.example", fetch: mismatchAgent.fetch });
    await expect(mismatchClient.sendMessage({
      ...request,
      message: { ...request.message, taskId: "task-1" },
    })).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
  });

  it("rejects malformed cards, oversized responses, and wrong JSON-RPC ids", async () => {
    const invalidFetch: typeof fetch = async () => Response.json({ name: "missing fields" });
    await expect(connectA2aClient({ agentUrl: "https://agent.example", fetch: invalidFetch }))
      .rejects.toMatchObject({ code: "AGENT_CARD_INVALID" });

    const hugeFetch: typeof fetch = async () => Response.json(validCard("HTTP+JSON"));
    await expect(connectA2aClient({
      agentUrl: "https://agent.example",
      fetch: hugeFetch,
      maxResponseBytes: 20,
    })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const agent = mockAgent("JSONRPC", { wrongResponseId: true });
    const client = await connectA2aClient({ agentUrl: "https://agent.example", fetch: agent.fetch });
    await expect(client.sendMessage(request)).rejects.toMatchObject({ code: "RESPONSE_ID_MISMATCH" });
  });
});

type MutableAgentCard = {
  -readonly [Key in keyof AgentCard]: AgentCard[Key] extends readonly (infer Item)[] ? Item[] : AgentCard[Key];
};

type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: unknown;
};

type MockOptions = {
  readonly tenant?: string;
  readonly card?: MutableAgentCard;
  readonly cardHeaders?: Readonly<Record<string, string>>;
  readonly wrongResponseId?: boolean;
  readonly fragmentSse?: boolean;
  readonly taskOverride?: unknown;
  readonly streamEvents?: readonly unknown[];
  readonly taskNotFound?: boolean;
  readonly onDiscovery?: (request: RecordedRequest) => Response | undefined;
};

function mockAgent(binding: SupportedBinding, options: MockOptions = {}): {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const card = options.card ?? validCard(binding, options.tenant);
  const responseTask = options.taskOverride ?? task;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const bodyText = request.body ? await request.clone().text() : undefined;
    const body = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    const recorded = { url: request.url, method: request.method, headers: request.headers, body };
    requests.push(recorded);

    if (request.url.includes("/.well-known/agent-card.json")) {
      const override = options.onDiscovery?.(recorded);
      if (override) return override;
      return Response.json(card, { headers: options.cardHeaders });
    }

    if (binding === "JSONRPC") {
      const rpc = body as { readonly id: number; readonly method: string };
      const id = options.wrongResponseId ? rpc.id + 100 : rpc.id;
      if (options.taskNotFound && rpc.method === "GetTask") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Task not found" },
        });
      }
      if (rpc.method === "SendStreamingMessage" || rpc.method === "SubscribeToTask") {
        const streamEvents = options.streamEvents ?? [{ task: submittedTask(responseTask) }, statusUpdate()];
        return sse(
          streamEvents.map((result) => ({ jsonrpc: "2.0", id, result })),
          options.fragmentSse,
        );
      }
      return Response.json({ jsonrpc: "2.0", id, result: resultForOperation(rpc.method, card, responseTask) }, {
        headers: { "Content-Type": "application/json" },
      });
    }

    const pathname = new URL(request.url).pathname;
    if (options.taskNotFound && pathname.includes("/tasks/missing-task")) {
      return Response.json({
        error: {
          code: 5,
          status: "NOT_FOUND",
          message: "Task not found",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "TASK_NOT_FOUND",
            domain: "a2a-protocol.org",
          }],
        },
      }, { status: 404 });
    }
    if (pathname.endsWith("/message:stream") || pathname.endsWith(":subscribe")) {
      return sse(options.streamEvents ?? [{ task: submittedTask(responseTask) }, statusUpdate()], options.fragmentSse);
    }
    if (pathname.endsWith("/message:send")) return a2aJson({ task: responseTask });
    if (pathname.endsWith("/tasks")) return a2aJson({ tasks: [responseTask], nextPageToken: "", pageSize: 10, totalSize: 1 });
    if (pathname.endsWith(":cancel") || pathname.includes("/tasks/task-1")) return a2aJson(responseTask);
    if (pathname.endsWith("/extendedAgentCard")) return a2aJson(card);
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, requests };
}

function validCard(binding: SupportedBinding, tenant?: string): MutableAgentCard {
  return {
    name: "Test Agent",
    description: "Deterministic contract agent",
    version: "1.0.0",
    supportedInterfaces: [{
      url: binding === "JSONRPC" ? "https://agent.example/rpc" : "https://agent.example/a2a",
      protocolBinding: binding,
      protocolVersion: "1.0",
      ...(tenant ? { tenant } : {}),
    }],
    capabilities: {
      streaming: true,
      extendedAgentCard: true,
      extensions: [{ uri: "https://example.com/a2ui/v0.9" }],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "chat", name: "Chat", description: "Chat", tags: ["chat"] }],
    signatures: [],
  };
}

function resultForOperation(method: string, card: unknown, responseTask: unknown): unknown {
  switch (method) {
    case "SendMessage": return { task: responseTask };
    case "GetTask":
    case "CancelTask": return responseTask;
    case "ListTasks": return { tasks: [responseTask], nextPageToken: "", pageSize: 10, totalSize: 1 };
    case "GetExtendedAgentCard": return card;
    default: return {};
  }
}

function statusUpdate(): unknown {
  return {
    statusUpdate: {
      taskId: "task-1",
      contextId: "context-1",
      status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-07-16T12:00:01Z" },
    },
  };
}

function submittedTask(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    status: {
      state: "TASK_STATE_SUBMITTED",
      timestamp: "2026-07-16T12:00:00Z",
    },
  };
}

function a2aJson(value: unknown): Response {
  return Response.json(value, { headers: { "Content-Type": "application/a2a+json" } });
}

function sse(events: readonly unknown[], fragmented = false): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const body = fragmented
    ? new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(payload);
        const boundaries = [1, 7, 19, 43, bytes.length - 3, bytes.length];
        let offset = 0;
        for (const boundary of boundaries) {
          if (boundary > offset) controller.enqueue(bytes.slice(offset, boundary));
          offset = boundary;
        }
        controller.close();
      },
    })
    : payload;
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
