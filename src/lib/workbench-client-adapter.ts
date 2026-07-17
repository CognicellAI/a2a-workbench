import {
  A2aClientError,
  MemoryAgentCardCache,
  connectA2aClient,
  type CredentialProvider,
  type EvidenceEvent,
  type JsonValue,
  type Metadata,
  type Part,
  type SecurityScheme,
  type SendMessageRequest,
} from "@a2a-workbench/client";
import { connectLegacyClient } from "@a2a-workbench/client/compat";
import {
  buildA2aStreamRequest,
  extractA2aMeta,
  extractA2aStatus,
  extractA2uiEnvelopes,
  extractNegotiatedA2uiEnvelopes,
  extractTextParts,
} from "@/lib/a2a";
import { A2UI_EXTENSION_URI, A2UI_MIME_TYPE, getA2uiClientCapabilities } from "@/lib/a2ui";
import {
  ConnectionError,
  normalizeConnection,
  redactHeaders,
  redactM2mOAuth,
} from "@/lib/connection";
import { WorkbenchUrlPolicy } from "@/lib/network-policy";
import { getM2mOAuthToken, OAuthTokenError } from "@/lib/oauth";
import { redactSecrets } from "@/lib/redaction";
import type {
  ConnectionProfileInput,
  NormalizedConnection,
  WorkbenchError,
  WorkbenchMessageInput,
  WorkbenchMode,
  WorkbenchOperation,
  WorkbenchPartInput,
} from "@/lib/workbench-types";

const cardCache = new MemoryAgentCardCache();
const FAILED_A2A_STATES = new Set([
  "TASK_STATE_FAILED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_CANCELED",
]);
const OPERATIONS = new Set<WorkbenchOperation>([
  "connect",
  "sendMessage",
  "sendStreamingMessage",
  "getTask",
  "listTasks",
  "cancelTask",
  "subscribeToTask",
  "getExtendedAgentCard",
]);

export type WorkbenchCommandBody = {
  readonly operation?: unknown;
  readonly message?: unknown;
  readonly messageDraft?: WorkbenchMessageInput;
  readonly contextId?: unknown;
  readonly taskId?: unknown;
  readonly pageSize?: unknown;
  readonly connection?: ConnectionProfileInput;
};

export type WorkbenchEmitter = (event: string, data: unknown) => void;

export async function runWorkbenchCommand(
  body: WorkbenchCommandBody,
  emit: WorkbenchEmitter,
  signal: AbortSignal,
): Promise<boolean> {
  const connection = normalizeConnection(body.connection);
  const mode = readMode(body.connection?.mode);
  const operation = readOperation(body.operation);
  const limits = readRouteLimits();

  if (mode === "compatibility") {
    return runCompatibility(body, connection, operation, emit, signal, limits);
  }
  return runStrict(body, connection, operation, emit, signal, limits);
}

async function runStrict(
  body: WorkbenchCommandBody,
  connection: NormalizedConnection,
  operation: WorkbenchOperation,
  emit: WorkbenchEmitter,
  signal: AbortSignal,
  limits: RouteLimits,
): Promise<boolean> {
  const urlPolicy = new WorkbenchUrlPolicy();
  const credentials = createWorkbenchCredentialProvider(connection, urlPolicy);
  const evidenceSink = {
    emit(event: EvidenceEvent) {
      emit("evidence", event);
      if (event.kind === "request") emit("request", event);
      if (event.kind === "response") emit("raw", event);
    },
  };
  const client = await connectA2aClient({
    agentUrl: connection.upstream,
    signal,
    requestedExtensions: [A2UI_EXTENSION_URI],
    credentialProvider: credentials,
    cache: cardCache,
    urlPolicy,
    evidenceSink,
    timeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxBytes,
  });
  const a2uiNegotiated = client.connection.negotiatedExtensions.includes(A2UI_EXTENSION_URI);

  emit("connection", {
    mode: "strict",
    ...client.connection,
    oauth: redactM2mOAuth(connection.oauth),
    headers: redactHeaders(connection.headers),
  });
  emit("agent-card", redactSecrets(client.getAgentCard()));

  switch (operation) {
    case "connect":
      return true;
    case "sendMessage": {
      const result = await client.sendMessage(buildStrictMessageRequest(body, a2uiNegotiated), { signal });
      return processProtocolPayload(result, emit, a2uiNegotiated, false);
    }
    case "sendStreamingMessage": {
      let ok = true;
      for await (const event of client.sendStreamingMessage(buildStrictMessageRequest(body, a2uiNegotiated), {
        signal,
      })) {
        ok = processProtocolPayload(event, emit, a2uiNegotiated, false) && ok;
      }
      return ok;
    }
    case "getTask": {
      const result = await client.getTask({ id: requireTaskId(body.taskId), historyLength: undefined }, { signal });
      return processProtocolPayload(result, emit, a2uiNegotiated, false);
    }
    case "listTasks": {
      const pageSize = readPageSize(body.pageSize);
      const result = await client.listTasks({
        contextId: readOptionalString(body.contextId),
        pageSize,
      }, { signal });
      return processProtocolPayload(result, emit, a2uiNegotiated, false);
    }
    case "cancelTask": {
      const result = await client.cancelTask({ id: requireTaskId(body.taskId) }, { signal });
      return processProtocolPayload(result, emit, a2uiNegotiated, false);
    }
    case "subscribeToTask": {
      let ok = true;
      for await (const event of client.subscribeToTask({ id: requireTaskId(body.taskId) }, { signal })) {
        ok = processProtocolPayload(event, emit, a2uiNegotiated, false) && ok;
      }
      return ok;
    }
    case "getExtendedAgentCard": {
      const card = await client.getExtendedAgentCard({ signal });
      emit("agent-card", redactSecrets(card));
      return true;
    }
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unhandled operation: ${exhaustive}`);
    }
  }
}

async function runCompatibility(
  body: WorkbenchCommandBody,
  connection: NormalizedConnection,
  operation: WorkbenchOperation,
  emit: WorkbenchEmitter,
  signal: AbortSignal,
  limits: RouteLimits,
): Promise<boolean> {
  if (operation !== "connect" && operation !== "sendMessage" && operation !== "sendStreamingMessage") {
    throw new A2aClientError(
      "UNSUPPORTED_CAPABILITY",
      `${operation} is not exposed by compatibility mode`,
      { operation },
    );
  }
  const urlPolicy = new WorkbenchUrlPolicy();
  const headers = Object.fromEntries(connection.headers.map((header) => [header.name, header.value]));
  if (connection.oauth) {
    await urlPolicy.assertAllowed(new URL(connection.oauth.tokenUrl), { purpose: "oauth" });
    const token = await getM2mOAuthToken(connection.oauth, signal);
    headers.Authorization = `${token.tokenType} ${token.accessToken}`;
  }
  const binding = readBinding(body.connection?.binding);
  const client = await connectLegacyClient({
    mode: "direct",
    endpoint: connection.upstream,
    binding,
    headers,
    urlPolicy,
    allowLocalhost: process.env.A2A_ALLOW_PRIVATE_NETWORKS === "true",
    timeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxBytes,
  });
  emit("connection", {
    ...client.connection,
    headers: redactHeaders(connection.headers),
    oauth: redactM2mOAuth(connection.oauth),
  });
  if (operation === "connect") return true;

  const request = body.messageDraft
    ? buildCompatibilityStructuredMessageRequest(body)
    : buildA2aStreamRequest({
      prompt: requireMessage(body.message),
      contextId: readOptionalString(body.contextId),
      a2uiTrigger: connection.a2uiTrigger,
    }).body as unknown as SendMessageRequest;
  emit("request", {
    mode: "compatibility",
    upstream: connection.upstream,
    body: redactSecrets(request),
  });
  if (operation === "sendMessage") {
    const result = await client.sendMessage(request, { signal });
    return processProtocolPayload(result, emit, true, true);
  }
  let ok = true;
  for await (const event of client.sendStreamingMessage(request, { signal })) {
    ok = processProtocolPayload(event, emit, true, true) && ok;
  }
  return ok;
}

function processProtocolPayload(
  payload: unknown,
  emit: WorkbenchEmitter,
  a2uiEnabled: boolean,
  compatibility: boolean,
): boolean {
  emit("a2a", redactSecrets(payload));
  const meta = extractA2aMeta(payload);
  if (meta) emit("meta", meta);
  const status = extractA2aStatus(payload);
  if (status) emit("status", status);
  extractTextParts(payload).forEach((text) => emit("text", { text }));

  if (a2uiEnabled) {
    const messages = compatibility
      ? extractA2uiEnvelopes(payload)
      : extractNegotiatedA2uiEnvelopes(payload);
    if (messages.length > 0) emit("a2ui", { messages, source: compatibility ? "compatibility" : "negotiated" });
  }
  return !status || !FAILED_A2A_STATES.has(status.state.toUpperCase());
}

function buildStrictMessageRequest(body: WorkbenchCommandBody, a2uiNegotiated: boolean): SendMessageRequest {
  const draft = readStrictMessageDraft(body);
  const message: SendMessageRequest["message"] = {
    messageId: draft.messageId ?? crypto.randomUUID(),
    role: "ROLE_USER",
    parts: draft.parts,
    ...(draft.contextId ? { contextId: draft.contextId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.metadata ? { metadata: draft.metadata } : {}),
    ...(draft.extensions ? { extensions: draft.extensions } : {}),
    ...(draft.referenceTaskIds ? { referenceTaskIds: draft.referenceTaskIds } : {}),
  };
  return {
    message,
    configuration: {
      acceptedOutputModes: a2uiNegotiated ? ["text/plain", A2UI_MIME_TYPE] : ["text/plain"],
    },
    ...(a2uiNegotiated
      ? { metadata: { a2uiClientCapabilities: getA2uiClientCapabilities() } as SendMessageRequest["metadata"] }
      : {}),
  };
}

type StrictMessageDraft = {
  readonly messageId?: string;
  readonly contextId?: string;
  readonly taskId?: string;
  readonly parts: readonly Part[];
  readonly metadata?: Metadata;
  readonly extensions?: readonly string[];
  readonly referenceTaskIds?: readonly string[];
};

function readStrictMessageDraft(body: WorkbenchCommandBody): StrictMessageDraft {
  if (!body.messageDraft) {
    return {
      parts: [{ text: requireMessage(body.message) }],
      contextId: readOptionalString(body.contextId),
      taskId: readOptionalString(body.taskId),
    };
  }

  const draft = body.messageDraft;
  const parts = readParts(draft.parts);
  return {
    messageId: readOptionalString(draft.messageId),
    contextId: readOptionalString(draft.contextId) ?? readOptionalString(body.contextId),
    taskId: readOptionalString(draft.taskId) ?? readOptionalString(body.taskId),
    parts,
    metadata: readMetadata(draft.metadata, "Message metadata"),
    extensions: readStringList(draft.extensions, "Message extensions"),
    referenceTaskIds: readStringList(draft.referenceTaskIds, "Reference task IDs"),
  };
}

function buildCompatibilityStructuredMessageRequest(body: WorkbenchCommandBody): SendMessageRequest {
  const draft = readStrictMessageDraft(body);
  return {
    message: {
      messageId: draft.messageId ?? crypto.randomUUID(),
      role: "ROLE_USER",
      parts: draft.parts,
      ...(draft.contextId ? { contextId: draft.contextId } : {}),
      ...(draft.taskId ? { taskId: draft.taskId } : {}),
      ...(draft.metadata ? { metadata: draft.metadata } : {}),
      ...(draft.extensions ? { extensions: draft.extensions } : {}),
      ...(draft.referenceTaskIds ? { referenceTaskIds: draft.referenceTaskIds } : {}),
    },
    configuration: { acceptedOutputModes: ["text/plain", "application/json"] },
  };
}

function readParts(value: unknown): readonly Part[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConnectionError("A message requires at least one Part.");
  }
  return value.map((entry, index) => readPart(entry, index));
}

function readPart(value: unknown, index: number): Part {
  if (!isRecord(value)) throw new ConnectionError(`Part ${index + 1} must be an object.`);
  const input = value as WorkbenchPartInput;
  const kind = readOptionalString(input.kind);
  const mediaType = readOptionalString(input.mediaType);
  const filename = readOptionalString(input.filename);
  const metadata = readMetadata(input.metadata, `Part ${index + 1} metadata`);
  const common = {
    ...(mediaType ? { mediaType } : {}),
    ...(filename ? { filename } : {}),
    ...(metadata ? { metadata } : {}),
  };

  switch (kind) {
    case "text":
      return { ...common, text: requirePartString(input.text, index, "text") };
    case "raw":
      return { ...common, raw: requirePartString(input.raw, index, "raw") };
    case "url": {
      const url = requirePartString(input.url, index, "url");
      try {
        new URL(url);
      } catch {
        throw new ConnectionError(`Part ${index + 1} URL must be valid.`);
      }
      return { ...common, url };
    }
    case "data":
      if (!isJsonValue(input.data)) throw new ConnectionError(`Part ${index + 1} data must be valid JSON.`);
      return { ...common, data: input.data };
    default:
      throw new ConnectionError(`Part ${index + 1} must use text, data, raw, or url.`);
  }
}

function requirePartString(value: unknown, index: number, field: string): string {
  const result = readOptionalString(value);
  if (!result) throw new ConnectionError(`Part ${index + 1} ${field} must be a non-empty string.`);
  return result;
}

function readMetadata(value: unknown, label: string): Metadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !isJsonValue(value)) throw new ConnectionError(`${label} must be a JSON object.`);
  return value as Metadata;
}

function readStringList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ConnectionError(`${label} must be an array of strings.`);
  const items = value.map((item) => readOptionalString(item));
  if (items.some((item) => !item)) throw new ConnectionError(`${label} must contain non-empty strings.`);
  return items as readonly string[];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createWorkbenchCredentialProvider(
  connection: NormalizedConnection,
  urlPolicy: WorkbenchUrlPolicy,
): CredentialProvider | undefined {
  if (connection.headers.length === 0 && !connection.oauth) return undefined;
  return {
    canProvide(_schemeName: string, scheme: SecurityScheme): boolean {
      if (connection.headers.length > 0) return true;
      return Boolean(connection.oauth && "oauth2SecurityScheme" in scheme &&
        scheme.oauth2SecurityScheme.flows?.clientCredentials);
    },
    async getHeaders(request) {
      const result = Object.fromEntries(connection.headers.map((header) => [header.name, header.value]));
      if (connection.oauth) {
        await urlPolicy.assertAllowed(new URL(connection.oauth.tokenUrl), { purpose: "oauth" });
        const token = await getM2mOAuthToken(connection.oauth, request.signal ?? new AbortController().signal);
        result.Authorization = `${token.tokenType} ${token.accessToken}`;
      }
      return result;
    },
  };
}

export function toWorkbenchError(error: unknown): WorkbenchError {
  if (error instanceof A2aClientError) {
    return { message: error.message, code: error.code, detail: redactSecrets(error.details) };
  }
  if (error instanceof ConnectionError) return { message: error.message };
  if (error instanceof OAuthTokenError) return { message: error.message, detail: redactSecrets(error.detail) };
  if (error instanceof Error) return { message: error.message };
  return { message: "Unexpected A2A workbench failure.", detail: redactSecrets(error) };
}

type RouteLimits = { readonly timeoutMs: number; readonly maxBytes: number };

function readRouteLimits(env: NodeJS.ProcessEnv = process.env): RouteLimits {
  return {
    timeoutMs: readPositiveInteger(env.A2A_UPSTREAM_TIMEOUT_MS, 120_000),
    maxBytes: readPositiveInteger(env.A2A_UPSTREAM_MAX_BYTES, 10 * 1024 * 1024),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readMode(value: unknown): WorkbenchMode {
  return value === "compatibility" ? "compatibility" : "strict";
}

function readBinding(value: unknown): "JSONRPC" | "HTTP+JSON" {
  return value === "JSONRPC" ? "JSONRPC" : "HTTP+JSON";
}

function readOperation(value: unknown): WorkbenchOperation {
  return typeof value === "string" && OPERATIONS.has(value as WorkbenchOperation)
    ? value as WorkbenchOperation
    : "sendStreamingMessage";
}

function requireMessage(value: unknown): string {
  const message = readOptionalString(value);
  if (!message) throw new ConnectionError("This operation requires a message.");
  return message;
}

function requireTaskId(value: unknown): string {
  const taskId = readOptionalString(value);
  if (!taskId) throw new ConnectionError("This operation requires a task ID.");
  return taskId;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPageSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ConnectionError("Page size must be an integer between 1 and 100.");
  }
  return pageSize;
}
