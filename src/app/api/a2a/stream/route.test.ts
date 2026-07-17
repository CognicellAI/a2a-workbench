import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSseBuffer } from "@/lib/sse";
import { POST } from "./route";

describe("A2A workbench strict route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A2A_UPSTREAM_ALLOWLIST;
    delete process.env.A2A_ALLOW_PRIVATE_NETWORKS;
    delete process.env.A2A_UPSTREAM_MAX_BYTES;
  });

  it("discovers an Agent Card and sends through its HTTP+JSON interface", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith("/.well-known/agent-card.json")) {
        return Response.json(agentCard());
      }
      return a2aJson({ task: completedTask() });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await invoke({
      operation: "sendMessage",
      message: "hello",
      connection: {
        mode: "strict",
        upstream: "https://93.184.216.34",
        headers: [],
      },
    });

    const operationRequest = requests.find((request) => request.url.includes("/a2a/message:send"));
    expect(operationRequest?.headers.get("a2a-version")).toBe("1.0");
    expect(operationRequest?.headers.get("content-type")).toBe("application/a2a+json");
    expect(events).toContainEqual({ event: "text", data: { text: "Strict response rendered." } });
    expect(events).toContainEqual({
      event: "meta",
      data: { taskId: "task-route", contextId: "ctx-route", status: "TASK_STATE_COMPLETED" },
    });
    expect(events.some((event) => event.event === "connection" &&
      (event.data as { selectedInterface?: { protocolBinding?: string } }).selectedInterface?.protocolBinding === "HTTP+JSON"))
      .toBe(true);
    expect(events.some((event) => event.event === "agent-card")).toBe(true);
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: true } });
  });

  it("runs task lifecycle operations through the same strict connection", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/.well-known/agent-card.json")) return Response.json(agentCard());
      if (new URL(request.url).pathname.endsWith("/tasks")) {
        return a2aJson({ tasks: [completedTask()], nextPageToken: "", pageSize: 50, totalSize: 1 });
      }
      return a2aJson(completedTask());
    }));

    const events = await invoke({
      operation: "getTask",
      taskId: "task-route",
      connection: { mode: "strict", upstream: "https://93.184.216.34", headers: [] },
    });
    expect(events).toContainEqual({
      event: "meta",
      data: { taskId: "task-route", contextId: "ctx-route", status: "TASK_STATE_COMPLETED" },
    });
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: true } });
  });

  it("sends a validated strict message draft with every A2A v1 Part variant", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith("/.well-known/agent-card.json")) return Response.json(agentCard());
      return a2aJson({ message: { messageId: "agent-message", role: "ROLE_AGENT", parts: [{ text: "Accepted." }] } });
    }));

    const events = await invoke({
      operation: "sendMessage",
      messageDraft: {
        messageId: "client-message",
        contextId: "ctx-draft",
        parts: [
          { kind: "text", text: "Describe this document." },
          { kind: "data", data: { priority: 1, labels: ["spec", "test"] } },
          { kind: "raw", raw: "aGVsbG8=", mediaType: "text/plain", filename: "note.txt" },
          { kind: "url", url: "https://example.com/document.pdf", mediaType: "application/pdf" },
        ],
        metadata: { source: "protocol-lab" },
        extensions: ["https://example.com/extensions/source"],
        referenceTaskIds: ["task-parent"],
      },
      connection: { mode: "strict", upstream: "https://93.184.216.34", headers: [] },
    });

    const operationRequest = requests.find((request) => request.url.includes("/a2a/message:send"));
    const payload = await operationRequest?.json();
    expect(payload).toMatchObject({
      message: {
        messageId: "client-message",
        contextId: "ctx-draft",
        parts: [
          { text: "Describe this document." },
          { data: { priority: 1, labels: ["spec", "test"] } },
          { raw: "aGVsbG8=", mediaType: "text/plain", filename: "note.txt" },
          { url: "https://example.com/document.pdf", mediaType: "application/pdf" },
        ],
        metadata: { source: "protocol-lab" },
        extensions: ["https://example.com/extensions/source"],
        referenceTaskIds: ["task-parent"],
      },
    });
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: true } });
  });

  it("sends structured compatibility message drafts without treating them as strict evidence", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return a2aJson({
        message: {
          messageId: "compatibility-agent-message",
          role: "ROLE_AGENT",
          content: [{ text: "Compatibility response rendered." }],
        },
      });
    }));

    const events = await invoke({
      operation: "sendMessage",
      messageDraft: { parts: [{ kind: "data", data: { legacy: false } }] },
      connection: {
        mode: "compatibility",
        upstream: "https://93.184.216.34/a2a",
        binding: "HTTP+JSON",
        headers: [],
      },
    });

    const operationRequest = requests.find((request) => request.method === "POST");
    expect(await operationRequest?.json()).toMatchObject({
      message: { content: [{ data: { data: { legacy: false } } }] },
      configuration: { acceptedOutputModes: ["text/plain", "application/json"] },
    });
    expect(events.some((event) => event.event === "connection" && (event.data as { mode?: string }).mode === "compatibility")).toBe(true);
    expect(events).toContainEqual({ event: "text", data: { text: "Compatibility response rendered." } });
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: true } });
  });

  it("blocks private-network targets before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const events = await invoke({
      operation: "connect",
      connection: { mode: "strict", upstream: "http://127.0.0.1", headers: [] },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      event: "error",
      data: {
        code: "URL_POLICY_REJECTED",
        detail: { purpose: "discovery" },
        message: "A2A strict mode requires HTTPS except for explicit local development.",
      },
    });
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: false } });
  });

  it("enforces the optional host allowlist during discovery", async () => {
    process.env.A2A_UPSTREAM_ALLOWLIST = "allowed.example.com";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const events = await invoke({
      operation: "connect",
      connection: { mode: "strict", upstream: "https://93.184.216.34", headers: [] },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      event: "error",
      data: {
        code: "URL_POLICY_REJECTED",
        detail: { purpose: "discovery" },
        message: "A2A upstream host is not in A2A_UPSTREAM_ALLOWLIST.",
      },
    });
  });

  it("surfaces response limits as typed client errors", async () => {
    process.env.A2A_UPSTREAM_MAX_BYTES = "20";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json(agentCard())));

    const events = await invoke({
      operation: "connect",
      connection: { mode: "strict", upstream: "https://93.184.216.34", headers: [] },
    });

    expect(events.some((event) => event.event === "error" &&
      (event.data as { code?: string }).code === "RESPONSE_TOO_LARGE")).toBe(true);
    expect(events.at(-1)).toEqual({ event: "done", data: { ok: false } });
  });
});

async function invoke(body: unknown): Promise<Array<{ event?: string; data: unknown }>> {
  const response = await POST(new Request("http://localhost/api/a2a/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return parseSseBuffer(await response.text()).frames.map((frame) => ({
    event: frame.event,
    data: JSON.parse(frame.data) as unknown,
  }));
}

function agentCard(): unknown {
  return {
    name: "Route Agent",
    description: "Strict route test agent",
    version: "1.0.0",
    supportedInterfaces: [{
      url: "https://93.184.216.34/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    }],
    capabilities: { streaming: true, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "chat", name: "Chat", description: "Chat", tags: ["chat"] }],
    signatures: [],
  };
}

function completedTask(): unknown {
  return {
    id: "task-route",
    contextId: "ctx-route",
    status: {
      state: "TASK_STATE_COMPLETED",
      message: {
        messageId: "agent-message",
        contextId: "ctx-route",
        taskId: "task-route",
        role: "ROLE_AGENT",
        parts: [{ text: "Strict response rendered." }],
      },
      timestamp: "2026-07-16T12:00:00Z",
    },
    artifacts: [],
    history: [],
  };
}

function a2aJson(value: unknown): Response {
  return Response.json(value, { headers: { "Content-Type": "application/a2a+json" } });
}
