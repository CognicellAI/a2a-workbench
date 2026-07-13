import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSseBuffer } from "@/lib/sse";
import { POST } from "./route";

describe("A2A workbench stream route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
            upstream: "https://agent.example/message:send",
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
});
