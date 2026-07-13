import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_UPSTREAM_MAX_BYTES = 10 * 1024 * 1024;
const RESERVED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
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
  const routeLimits = readRouteLimits();
  const upstreamAbort = createUpstreamAbort(request.signal, routeLimits.timeoutMs);

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
        await assertSafeUpstreamUrl(connection.upstream);
        const contextId = typeof body.contextId === "string" ? body.contextId : undefined;
        const built = buildA2aStreamRequest({
          prompt: message,
          contextId,
          a2uiTrigger: connection.a2uiTrigger,
        });
        const oauthToken = connection.oauth ? await getM2mOAuthToken(connection.oauth, upstreamAbort.signal) : undefined;
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
          signal: upstreamAbort.signal,
        });

        const contentType = upstream.headers.get("content-type") ?? "";
        const ok = contentType.toLowerCase().includes("text/event-stream")
          ? await forwardStreamingResponse(upstream, emit, routeLimits.maxBytes)
          : await forwardJsonResponse(upstream, contentType, emit, routeLimits.maxBytes);
        emit("done", { ok });
      } catch (error) {
        emit("error", toWorkbenchError(error));
        emit("done", { ok: false });
      } finally {
        upstreamAbort.dispose();
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}

async function forwardStreamingResponse(
  upstream: Response,
  emit: (event: string, data: unknown) => void,
  maxBytes: number,
): Promise<boolean> {
  if (!upstream.body) {
    emit("error", { message: "Upstream response did not include a stream body.", status: upstream.status });
    return false;
  }

  return forwardUpstreamStream(upstream.body, emit, maxBytes);
}

async function forwardJsonResponse(
  upstream: Response,
  contentType: string,
  emit: (event: string, data: unknown) => void,
  maxBytes: number,
): Promise<boolean> {
  const read = await readResponseText(upstream, maxBytes);
  if (read.truncated) {
    emit("error", {
      message: "Upstream response exceeded the configured byte limit.",
      status: upstream.status,
      detail: { maxBytes },
    });
    return false;
  }

  const text = read.text;
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

async function forwardUpstreamStream(
  body: ReadableStream<Uint8Array>,
  emit: (event: string, data: unknown) => void,
  maxBytes: number,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = true;
  let bytesRead = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      emit("error", {
        message: "Upstream stream exceeded the configured byte limit.",
        detail: { maxBytes },
      });
      return false;
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

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { text, truncated: true };
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, truncated: false };
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

type RouteLimits = {
  timeoutMs: number;
  maxBytes: number;
};

function readRouteLimits(env: NodeJS.ProcessEnv = process.env): RouteLimits {
  return {
    timeoutMs: readPositiveInteger(env.A2A_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),
    maxBytes: readPositiveInteger(env.A2A_UPSTREAM_MAX_BYTES, DEFAULT_UPSTREAM_MAX_BYTES),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createUpstreamAbort(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new UpstreamTimeoutError(timeoutMs));
  }, timeoutMs);
  const abortFromParent = () => {
    controller.abort(parent.reason);
  };

  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

async function assertSafeUpstreamUrl(urlString: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = new URL(urlString);
  const allowlist = readAllowlist(env.A2A_UPSTREAM_ALLOWLIST);
  const hostname = normalizeHostname(url.hostname);

  if (allowlist.length > 0 && !matchesAllowlist(hostname, allowlist)) {
    throw new ConnectionError("A2A upstream host is not in A2A_UPSTREAM_ALLOWLIST.");
  }

  if (env.A2A_ALLOW_PRIVATE_NETWORKS === "true") {
    return;
  }

  if (RESERVED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
  }

  const ipFamily = isIP(hostname);
  if (ipFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ConnectionError("A2A upstream hostname could not be resolved.");
  }

  if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedIp(address.address))) {
    throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
  }
}

function readAllowlist(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => normalizeAllowlistEntry(entry.trim()))
      .filter((entry) => entry.length > 0) ?? []
  );
}

function normalizeAllowlistEntry(entry: string): string {
  if (!entry) {
    return "";
  }

  try {
    return normalizeHostname(new URL(entry).hostname);
  } catch {
    return normalizeHostname(entry);
  }
}

function matchesAllowlist(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
    }

    if (entry.startsWith(".")) {
      const root = entry.slice(1);
      return hostname === root || hostname.endsWith(entry);
    }

    return hostname === entry;
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isPrivateOrReservedIp(ip: string): boolean {
  const mappedIpv4 = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) {
    return isPrivateOrReservedIpv4(mappedIpv4);
  }

  return isIP(ip) === 4 ? isPrivateOrReservedIpv4(ip) : isPrivateOrReservedIpv6(ip);
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8")
  );
}

class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`A2A upstream request timed out after ${timeoutMs}ms.`);
    this.name = "UpstreamTimeoutError";
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
