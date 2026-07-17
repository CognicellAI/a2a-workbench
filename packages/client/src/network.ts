import { A2aClientError } from "./errors.js";
import { emitEvidence, headersToRecord } from "./evidence.js";
import type {
  CredentialProvider,
  EvidenceSink,
  OperationName,
  SupportedBinding,
  UrlPolicy,
  UrlPolicyContext,
} from "./types.js";
import {
  validateRawProtocolRequest,
  validateRawProtocolResponse,
  validateRawSsePayload,
} from "./validation.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PROTECTED_HEADERS = new Set(["a2a-version", "a2a-extensions", "content-length", "host"]);

export class DefaultUrlPolicy implements UrlPolicy {
  readonly #allowLocalhost: boolean;

  constructor(options: { readonly allowLocalhost?: boolean } = {}) {
    this.#allowLocalhost = options.allowLocalhost ?? false;
  }

  assertAllowed(url: URL, context: UrlPolicyContext): void {
    if (url.protocol === "https:") {
      return;
    }
    if (url.protocol === "http:" && this.#allowLocalhost && isLoopbackHost(url.hostname)) {
      return;
    }
    throw new A2aClientError("URL_POLICY_REJECTED", `URL policy rejected ${url.origin}`, {
      operation: context.purpose === "discovery" ? "discover" : "sendMessage",
      details: { purpose: context.purpose, protocol: url.protocol },
    });
  }
}

export type PolicyFetchOptions = {
  readonly fetchImpl: typeof fetch;
  readonly urlPolicy: UrlPolicy;
  readonly evidenceSink?: EvidenceSink;
  readonly credentialProvider?: CredentialProvider;
  readonly credentialContext?: Omit<Parameters<CredentialProvider["getHeaders"]>[0], "operation" | "signal">;
  readonly operation: OperationName;
  readonly binding?: SupportedBinding;
  readonly purpose: UrlPolicyContext["purpose"];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
};

export function createPolicyFetch(options: PolicyFetchOptions): typeof fetch {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const originalRequest = new Request(input, init);
    const operation = await inferOperation(originalRequest, options.operation);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "AbortError")), options.timeoutMs);
    const signal = combineSignals(originalRequest.signal, controller.signal);

    try {
      const credentialHeaders = options.credentialProvider && options.credentialContext
        ? await options.credentialProvider.getHeaders({ ...options.credentialContext, operation, signal })
        : {};
      const secretHeaderNames = new Set(Object.keys(credentialHeaders).map((name) => name.toLowerCase()));
      const headers = new Headers(originalRequest.headers);
      Object.entries(credentialHeaders).forEach(([name, value]) => {
        if (!PROTECTED_HEADERS.has(name.toLowerCase())) {
          headers.set(name, value);
        }
      });

      let request = new Request(originalRequest, { headers, signal });
      const initialOrigin = new URL(request.url).origin;

      for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
        const url = new URL(request.url);
        await options.urlPolicy.assertAllowed(url, { purpose: options.purpose });
        const requestBody = await readableRequestBody(request);
        if (options.binding && requestBody) {
          validateRawProtocolRequest(parseRequiredJson(requestBody, operation), options.binding, operation);
        }
        await emitEvidence(options.evidenceSink, {
          kind: "request",
          operation,
          binding: options.binding,
          url: url.href,
          details: {
            method: request.method,
            headers: headersToRecord(request.headers, secretHeaderNames),
            body: requestBody,
          },
        });

        const response = await options.fetchImpl(request, { redirect: "manual", signal });
        if (!REDIRECT_STATUSES.has(response.status)) {
          const bounded = boundResponseBody(response, options.maxResponseBytes, operation);
          const contentType = bounded.headers.get("content-type")?.toLowerCase() ?? "";
          const validated = options.binding && contentType.includes("text/event-stream") &&
              (operation === "sendStreamingMessage" || operation === "subscribeToTask")
            ? validateSseResponse(bounded, options.binding, operation, options.evidenceSink, url.href)
            : bounded;
          const responseDetails: Record<string, unknown> = {
            status: validated.status,
            headers: headersToRecord(validated.headers),
          };
          if (!contentType.includes("text/event-stream")) {
            const body = await validated.clone().text();
            const parsedBody = parseJsonOrText(body);
            responseDetails.body = parsedBody;
            if (options.binding && response.ok && parsedBody !== undefined) {
              validateRawProtocolResponse(parsedBody, options.binding, operation);
            } else if (options.binding === "JSONRPC" && parsedBody !== undefined) {
              validateRawProtocolResponse(parsedBody, options.binding, operation);
            }
          }
          await emitEvidence(options.evidenceSink, {
            kind: "response",
            operation,
            binding: options.binding,
            url: url.href,
            details: responseDetails,
          });
          return validated;
        }

        const location = response.headers.get("location");
        if (!location || redirectCount === options.maxRedirects) {
          throw new A2aClientError("URL_POLICY_REJECTED", "Redirect limit exceeded or Location was missing", {
            operation,
            httpStatus: response.status,
          });
        }
        const nextUrl = new URL(location, url);
        if (nextUrl.origin !== initialOrigin) {
          throw new A2aClientError("URL_POLICY_REJECTED", "Cross-origin redirects are not allowed", {
            operation,
            details: { from: url.origin, to: nextUrl.origin },
          });
        }
        await options.urlPolicy.assertAllowed(nextUrl, { purpose: options.purpose, redirectFrom: url });
        request = redirectRequest(request, nextUrl, response.status, signal);
      }

      throw new A2aClientError("URL_POLICY_REJECTED", "Redirect limit exceeded", {
        operation,
      });
    } catch (error) {
      if (controller.signal.aborted && !(originalRequest.signal.aborted)) {
        throw new A2aClientError("TIMEOUT", `${operation} timed out`, {
          operation,
          retryable: true,
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  operation: OperationName,
): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new A2aClientError("RESPONSE_TOO_LARGE", `Response exceeded ${maxBytes} bytes`, {
      operation,
      httpStatus: response.status,
    });
  }
  return new TextDecoder().decode(buffer);
}

function boundResponseBody(response: Response, maxBytes: number, operation: OperationName): Response {
  if (!response.body) {
    return response;
  }
  let received = 0;
  const boundedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          controller.error(
            new A2aClientError("RESPONSE_TOO_LARGE", `Response exceeded ${maxBytes} bytes`, {
              operation,
              httpStatus: response.status,
            }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function redirectRequest(request: Request, url: URL, status: number, signal: AbortSignal): Request {
  const becomesGet = status === 303 || ((status === 301 || status === 302) && request.method === "POST");
  return new Request(url, {
    method: becomesGet ? "GET" : request.method,
    headers: request.headers,
    body: becomesGet ? undefined : request.body,
    duplex: becomesGet ? undefined : "half",
    signal,
  } as RequestInit);
}

async function readableRequestBody(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return undefined;
  }
  try {
    return await request.clone().text();
  } catch {
    return "[unavailable]";
  }
}

function combineSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const active = signals.filter((signal) => signal !== undefined);
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

async function inferOperation(request: Request, fallback: OperationName): Promise<OperationName> {
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/.well-known/agent-card.json")) return "discover";
  if (pathname.endsWith("/extendedAgentCard")) return "getExtendedAgentCard";
  if (pathname.endsWith("/message:send")) return "sendMessage";
  if (pathname.endsWith("/message:stream")) return "sendStreamingMessage";
  if (/\/tasks\/[^/]+:cancel$/.test(pathname)) return "cancelTask";
  if (/\/tasks\/[^/]+:subscribe$/.test(pathname)) return "subscribeToTask";
  if (/\/tasks\/[^/]+$/.test(pathname)) return "getTask";
  if (pathname.endsWith("/tasks")) return "listTasks";

  if (request.method === "POST" && request.body) {
    try {
      const payload: unknown = JSON.parse(await request.clone().text());
      if (isRecord(payload) && typeof payload.method === "string") {
        return jsonRpcOperation(payload.method) ?? fallback;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function jsonRpcOperation(method: string): OperationName | undefined {
  const operations: Readonly<Record<string, OperationName>> = {
    SendMessage: "sendMessage",
    SendStreamingMessage: "sendStreamingMessage",
    GetTask: "getTask",
    ListTasks: "listTasks",
    CancelTask: "cancelTask",
    SubscribeToTask: "subscribeToTask",
    GetExtendedAgentCard: "getExtendedAgentCard",
  };
  return operations[method];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOrText(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRequiredJson(value: string, operation: OperationName): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new A2aClientError("PROTOCOL_VIOLATION", "Outbound A2A payload was not valid JSON", {
      operation,
      cause: error,
    });
  }
}

function validateSseResponse(
  response: Response,
  binding: SupportedBinding,
  operation: "sendStreamingMessage" | "subscribeToTask",
  evidenceSink: EvidenceSink | undefined,
  url: string,
): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let buffer = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      await validateAvailableFrames(false);
      controller.enqueue(chunk);
    },
    async flush() {
      buffer += decoder.decode();
      await validateAvailableFrames(true);
    },
  }));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  async function validateAvailableFrames(final: boolean): Promise<void> {
    const frames: string[] = [];
    while (true) {
      const separator = /(?:\r\n|\r|\n){2}/.exec(buffer);
      if (!separator || separator.index === undefined) break;
      frames.push(buffer.slice(0, separator.index));
      buffer = buffer.slice(separator.index + separator[0].length);
    }
    if (final && buffer.trim()) {
      frames.push(buffer);
      buffer = "";
    }
    for (const frame of frames) {
      const data = frame.split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch (error) {
        throw new A2aClientError("STREAM_INVALID", "SSE data field was not valid JSON", {
          operation,
          cause: error,
        });
      }
      validateRawSsePayload(payload, binding, operation);
      await emitEvidence(evidenceSink, {
        kind: "stream",
        operation,
        binding,
        url,
        details: { stage: "wire", payload },
      });
    }
  }
}
