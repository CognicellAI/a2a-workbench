import { describe, expect, it } from "vitest";
import { A2UI_BASIC_CATALOG_ID } from "@/lib/a2ui";
import {
  buildA2aStreamRequest,
  extractA2aError,
  extractA2aMeta,
  extractA2aStatus,
  extractA2uiEnvelopes,
  extractTextParts,
  withA2uiTrigger,
} from "@/lib/a2a";
import { redactSecrets } from "@/lib/redaction";
import { parseSseBuffer } from "@/lib/sse";

describe("SSE parsing", () => {
  it("parses multiline data frames with a remainder", () => {
    const parsed = parseSseBuffer("event: raw\ndata: {\"a\":1\ndata: }\n\nid: later");

    expect(parsed.frames).toEqual([{ event: "raw", data: '{"a":1\n}' }]);
    expect(parsed.remainder).toBe("id: later");
  });
});

describe("A2A request construction", () => {
  it("builds message/stream with trigger, context, and A2UI capabilities", () => {
    const built = buildA2aStreamRequest({
      prompt: "Render a status card",
      contextId: "ctx-1",
      a2uiTrigger: "[a2ui]",
    });

    expect(built.body).toMatchObject({
      configuration: {
        acceptedOutputModes: ["text/plain"],
      },
      message: {
        messageId: built.messageId,
        role: "ROLE_USER",
        contextId: "ctx-1",
        parts: [{ text: "Render a status card\n\n[a2ui]" }],
      },
      metadata: {
        a2uiClientCapabilities: {
          "v0.9": {
            supportedCatalogIds: [A2UI_BASIC_CATALOG_ID],
          },
        },
      },
    });
    expect(built.body).not.toHaveProperty("contextId");
    expect(built.body.metadata).not.toHaveProperty("kennel.clientContext");
  });

  it("does not duplicate an existing A2UI trigger", () => {
    expect(withA2uiTrigger("hello [a2ui]", "[a2ui]")).toBe("hello [a2ui]");
  });
});

describe("A2A extraction", () => {
  it("extracts metadata and status from statusUpdate wrappers", () => {
    const payload = {
      result: {
        statusUpdate: {
          taskId: "task-1",
          contextId: "ctx-1",
          kind: "status-update",
          status: { state: "failed", final: true },
        },
      },
    };

    expect(extractA2aMeta(payload)).toMatchObject({
      taskId: "task-1",
      contextId: "ctx-1",
      kind: "status-update",
      final: true,
      status: "failed",
    });
    expect(extractA2aStatus(payload)).toEqual({ state: "failed", final: true, message: undefined });
  });

  it("extracts nested task status and error messages", () => {
    const payload = {
      contextId: "ctx-2",
      error: { message: "A2A invocation failed" },
      task: {
        contextId: "ctx-2",
        id: "task_30",
        status: {
          error: { message: "A2A invocation failed" },
          state: "TASK_STATE_FAILED",
        },
      },
    };

    expect(extractA2aMeta(payload)).toMatchObject({
      taskId: "task_30",
      contextId: "ctx-2",
      status: "TASK_STATE_FAILED",
    });
    expect(extractA2aStatus(payload)).toEqual({
      state: "TASK_STATE_FAILED",
      final: undefined,
      message: "A2A invocation failed",
    });
  });

  it("extracts upstream A2A error frames", () => {
    expect(extractA2aError({ error: "session is not owned by this caller" })).toEqual({
      message: "session is not owned by this caller",
    });
  });

  it("extracts text while stripping legacy fenced A2UI blocks", () => {
    const payload = {
      result: {
        message: {
          parts: [
            {
              kind: "text",
              text: "Here is the surface.\n```a2ui\n{\"version\":\"v0.9\",\"updateDataModel\":{\"data\":{\"ok\":true}}}\n```",
            },
          ],
        },
      },
    };

    expect(extractTextParts(payload)).toEqual(["Here is the surface."]);
  });

  it("deduplicates repeated message text in HTTP+JSON send responses", () => {
    const payload = {
      message: {
        parts: [{ kind: "text", text: "The final answer." }],
      },
      task: {
        status: {
          message: {
            parts: [{ kind: "text", text: "The final answer." }],
          },
        },
      },
    };

    expect(extractTextParts(payload)).toEqual(["The final answer."]);
  });

  it("extracts normalized A2UI data parts", () => {
    const payload = {
      result: {
        artifact: {
          parts: [
            {
              kind: "data",
              mimeType: "application/a2ui+json",
              data: {
                updateDataModel: { data: { ready: true } },
              },
            },
          ],
        },
      },
    };

    expect(extractA2uiEnvelopes(payload)).toEqual([
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "investigation",
          catalogId: A2UI_BASIC_CATALOG_ID,
        },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "investigation",
          path: "/",
          value: { ready: true },
          data: { ready: true },
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "investigation",
          components: [
            {
              id: "a2uiFallbackText",
              component: "Text",
              text: "A2UI emitted data without a root component.",
              variant: "body",
            },
            {
              id: "root",
              component: "Column",
              children: ["a2uiFallbackText"],
              align: "stretch",
            },
          ],
        },
      },
    ]);
  });
});

describe("redaction", () => {
  it("redacts secret-shaped keys recursively", () => {
    expect(
      redactSecrets({
        nested: {
          apiKey: "secret",
          normal: "visible",
        },
      }),
    ).toEqual({
      nested: {
        apiKey: "[redacted]",
        normal: "visible",
      },
    });
  });
});
