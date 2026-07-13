import { A2UI_EXTENSION_URI } from "@/lib/a2ui";
import {
  buildA2aStreamRequest,
  extractA2aError,
  extractA2aMeta,
  extractA2aStatus,
  extractA2uiEnvelopes,
  extractTextParts,
} from "@/lib/a2a";
import { ConnectionError, isSecretHeaderName, normalizeConnection, redactM2mOAuth, redactHeaders } from "@/lib/connection";
import { getM2mOAuthToken, OAuthTokenError } from "@/lib/oauth";
import { redactSecrets } from "@/lib/redaction";
import { encodeSseEvent, parseSseBuffer } from "@/lib/sse";
import type { ConnectionProfileInput } from "@/lib/workbench-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamRequestBody = {
  message?: unknown;
  contextId?: unknown;
  connection?: ConnectionProfileInput;
};

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};
const FAILED_A2A_STATES = new Set([
  "failed",
  "error",
  "rejected",
  "canceled",
  "cancelled",
  "task_state_failed",
  "task_state_rejected",
  "task_state_canceled",
  "task_state_cancelled",
]);
export async function POST(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      try {
        const body = (await request.json()) as StreamRequestBody;
        const message = typeof body.message === "string" ? body.message.trim() : "";

        if (!message) {
          emit("error", { message: "Missing prompt." });
          emit("done", { ok: false });
          return;
        }

        const connection = normalizeConnection(body.connection);
        const contextId = typeof body.contextId === "string" ? body.contextId : undefined;
        const built = buildA2aStreamRequest({
          prompt: message,
          contextId,
          a2uiTrigger: connection.a2uiTrigger,
        });
        const oauthToken = connection.oauth ? await getM2mOAuthToken(connection.oauth, request.signal) : undefined;
        const upstreamHeaders = buildUpstreamHeaders(connection.headers, oauthToken);

        emit("request", {
          upstream: connection.upstream,
          headers: oauthToken ? redactOutboundHeaders(upstreamHeaders) : redactHeaders(connection.headers),
          oauth: redactM2mOAuth(connection.oauth),
          oauthToken: oauthToken ? { tokenType: oauthToken.tokenType, expiresIn: oauthToken.expiresIn } : undefined,
          body: redactSecrets(built.body),
        });

        const upstream = await fetch(connection.upstream, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(built.body),
          signal: request.signal,
        });

        const contentType = upstream.headers.get("content-type") ?? "";
        const ok = contentType.toLowerCase().includes("text/event-stream")
          ? await forwardStreamingResponse(upstream, emit)
          : await forwardJsonResponse(upstream, contentType, emit);
        emit("done", { ok });
      } catch (error) {
        emit("error", toWorkbenchError(error));
        emit("done", { ok: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}

async function forwardStreamingResponse(upstream: Response, emit: (event: string, data: unknown) => void): Promise<boolean> {
  if (!upstream.body) {
    emit("error", { message: "Upstream response did not include a stream body.", status: upstream.status });
    return false;
  }

  return forwardUpstreamStream(upstream.body, emit);
}

async function forwardJsonResponse(
  upstream: Response,
  contentType: string,
  emit: (event: string, data: unknown) => void,
): Promise<boolean> {
  const text = await upstream.text();
  const payload = parseJson(text);

  if (payload === undefined) {
    emit("error", {
      message: "Upstream did not return text/event-stream or parseable JSON.",
      status: upstream.status,
      detail: {
        contentType,
        preview: text.slice(0, 1200),
      },
    });
    return false;
  }

  const ok = processUpstreamPayload(payload, { data: text, event: "message.send" }, emit);
  if (!upstream.ok) {
    emit("error", {
      message: `Upstream returned HTTP ${upstream.status}.`,
      status: upstream.status,
      detail: redactSecrets(payload),
    });
    return false;
  }

  return ok;
}

async function forwardUpstreamStream(body: ReadableStream<Uint8Array>, emit: (event: string, data: unknown) => void): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = true;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.remainder;
    parsed.frames.forEach((frame) => {
      ok = processUpstreamFrame(frame, emit) && ok;
    });
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    parseSseBuffer(`${buffer}\n\n`).frames.forEach((frame) => {
      ok = processUpstreamFrame(frame, emit) && ok;
    });
  }

  return ok;
}

function processUpstreamFrame(frame: { data: string; event?: string; id?: string; retry?: number }, emit: (event: string, data: unknown) => void): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    emit("error", {
      message: "Malformed upstream SSE JSON frame.",
      detail: frame.data.slice(0, 1200),
    });
    return false;
  }

  return processUpstreamPayload(payload, frame, emit);
}

function processUpstreamPayload(
  payload: unknown,
  source: { data: string; event?: string; id?: string; retry?: number },
  emit: (event: string, data: unknown) => void,
): boolean {
  emit("raw", source);
  emit("a2a", redactSecrets(payload));

  let ok = true;
  const meta = extractA2aMeta(payload);
  if (meta) {
    emit("meta", meta);
  }

  const status = extractA2aStatus(payload);
  if (status) {
    emit("status", status);
    ok = !isFailedA2aState(status.state) && ok;
  }

  const upstreamError = extractA2aError(payload);
  if (upstreamError && !status) {
    emit("error", {
      ...upstreamError,
      detail: redactSecrets(payload),
    });
    ok = false;
  }

  extractTextParts(payload).forEach((text) => {
    emit("text", { text });
  });

  const a2ui = extractA2uiEnvelopes(payload);
  if (a2ui.length > 0) {
    emit("a2ui", { messages: a2ui, source: source.event ?? "message" });
  }

  return ok;
}

function isFailedA2aState(state: string): boolean {
  return FAILED_A2A_STATES.has(state.toLowerCase());
}

function buildUpstreamHeaders(
  headers: { name: string; value: string }[],
  oauthToken?: { accessToken: string; tokenType: string },
): Headers {
  const upstreamHeaders = new Headers();
  headers.forEach((header) => {
    upstreamHeaders.set(header.name, header.value);
  });
  if (oauthToken) {
    upstreamHeaders.set("Authorization", `${oauthToken.tokenType} ${oauthToken.accessToken}`);
  }
  upstreamHeaders.set("Accept", "text/event-stream, application/a2a+json, application/json");
  upstreamHeaders.set("Content-Type", "application/a2a+json");
  upstreamHeaders.set("X-A2A-Extensions", A2UI_EXTENSION_URI);
  return upstreamHeaders;
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function redactOutboundHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [name, isSecretHeaderName(name) ? "[redacted]" : value]),
  );
}

function toWorkbenchError(error: unknown): { message: string; detail?: unknown } {
  if (error instanceof ConnectionError) {
    return { message: error.message };
  }

  if (error instanceof OAuthTokenError) {
    return { message: error.message, detail: error.detail };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: "Unexpected stream error.", detail: error };
}
