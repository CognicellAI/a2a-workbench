import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSseBuffer } from "@/lib/sse";
import { POST } from "./route";

describe("A2A workbench stream route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A2A_UPSTREAM_ALLOWLIST;
    delete process.env.A2A_ALLOW_PRIVATE_NETWORKS;
    delete process.env.A2A_UPSTREAM_MAX_BYTES;
  });

  it("normalizes HTTP+JSON message:send responses into workbench events", async () => {
    const upstreamPayload = {
      contextId: "ctx-json",
      message: {
        messageId: "agent-message",
        role: "ROLE_AGENT",
        parts: [{ kind: "text", text: "JSON send response rendered." }],
      },
      task: {
        contextId: "ctx-json",
        id: "task-json",
        status: {
          state: "TASK_STATE_COMPLETED",
          message: {
            messageId: "agent-message",
            role: "ROLE_AGENT",
            parts: [{ kind: "text", text: "JSON send response rendered." }],
          },
        },
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify(upstreamPayload), {
        status: 200,
        headers: {
          "content-type": "application/a2a+json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/a2a/stream", {
        method: "POST",
        body: JSON.stringify({
          message: "hello",
          connection: {
            upstream: "https://93.184.216.34/message:send",
            a2uiTrigger: "",
            headers: [],
          },
        }),
      }),
    );
    const parsed = parseSseBuffer(await response.text()).frames.map((frame) => ({
      event: frame.event,
      data: JSON.parse(frame.data) as unknown,
    }));
    const upstreamHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;

    expect(upstreamHeaders.get("accept")).toContain("application/a2a+json");
    expect(upstreamHeaders.get("content-type")).toBe("application/a2a+json");
    expect(parsed).toContainEqual({
      event: "text",
      data: { text: "JSON send response rendered." },
    });
    expect(parsed).toContainEqual({
      event: "meta",
      data: {
        taskId: "task-json",
        contextId: "ctx-json",
        status: "TASK_STATE_COMPLETED",
      },
    });
    expect(parsed.at(-1)).toEqual({ event: "done", data: { ok: true } });
  });

  it("blocks private-network upstream targets before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/a2a/stream", {
        method: "POST",
        body: JSON.stringify({
          message: "hello",
          connection: {
            upstream: "http://127.0.0.1/message:send",
            a2uiTrigger: "",
            headers: [],
          },
        }),
      }),
    );
    const parsed = parseSseBuffer(await response.text()).frames.map((frame) => ({
      event: frame.event,
      data: JSON.parse(frame.data) as { message?: string; ok?: boolean },
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(parsed).toContainEqual({
      event: "error",
      data: { message: "A2A upstream host resolves to a private or reserved network." },
    });
    expect(parsed.at(-1)).toEqual({ event: "done", data: { ok: false } });
  });

  it("enforces an optional upstream host allowlist", async () => {
    process.env.A2A_UPSTREAM_ALLOWLIST = "allowed.example.com";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/a2a/stream", {
        method: "POST",
        body: JSON.stringify({
          message: "hello",
          connection: {
            upstream: "https://93.184.216.34/message:send",
            a2uiTrigger: "",
            headers: [],
          },
        }),
      }),
    );
    const parsed = parseSseBuffer(await response.text()).frames.map((frame) => ({
      event: frame.event,
      data: JSON.parse(frame.data) as { message?: string; ok?: boolean },
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(parsed).toContainEqual({
      event: "error",
      data: { message: "A2A upstream host is not in A2A_UPSTREAM_ALLOWLIST." },
    });
    expect(parsed.at(-1)).toEqual({ event: "done", data: { ok: false } });
  });

  it("stops oversized non-streaming upstream responses", async () => {
    process.env.A2A_UPSTREAM_MAX_BYTES = "10";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        return new Response(JSON.stringify({ task: { id: "task-too-large" } }), {
          status: 200,
          headers: {
            "content-type": "application/a2a+json",
          },
        });
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/a2a/stream", {
        method: "POST",
        body: JSON.stringify({
          message: "hello",
          connection: {
            upstream: "https://93.184.216.34/message:send",
            a2uiTrigger: "",
            headers: [],
          },
        }),
      }),
    );
    const parsed = parseSseBuffer(await response.text()).frames.map((frame) => ({
      event: frame.event,
      data: JSON.parse(frame.data) as { message?: string; ok?: boolean },
    }));

    expect(parsed).toContainEqual({
      event: "error",
      data: {
        message: "Upstream response exceeded the configured byte limit.",
        status: 200,
        detail: { maxBytes: 10 },
      },
    });
    expect(parsed.at(-1)).toEqual({ event: "done", data: { ok: false } });
  });
});
