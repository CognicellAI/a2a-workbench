import {
  AgentCard as SdkAgentCard,
  CancelTaskRequest as SdkCancelTaskRequest,
  GetTaskRequest as SdkGetTaskRequest,
  ListTasksRequest as SdkListTasksRequest,
  ListTasksResponse as SdkListTasksResponse,
  Message as SdkMessage,
  SendMessageRequest as SdkSendMessageRequest,
  StreamResponse as SdkStreamResponse,
  SubscribeToTaskRequest as SdkSubscribeToTaskRequest,
  Task as SdkTask,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  JsonRpcTransportFactory,
  RestTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client as SdkClient,
  type RequestOptions as SdkRequestOptions,
  type TransportFactory,
} from "@a2a-js/sdk/client";
import { MemoryAgentCardCache } from "./cache.js";
import { discoverAgentCard, verifyCardTrust } from "./discovery.js";
import { A2aClientError, asA2aClientError } from "./errors.js";
import { emitEvidence } from "./evidence.js";
import { negotiateConnection } from "./negotiation.js";
import { createPolicyFetch, DefaultUrlPolicy } from "./network.js";
import { selectSecurityRequirement } from "./security.js";
import type {
  A2aClient,
  AgentCard,
  Clock,
  ConnectionMetadata,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  OperationName,
  RequestOptions,
  SendMessageRequest,
  SendMessageResult,
  StreamResponse,
  StrictClientOptions,
  SubscribeToTaskRequest,
  Task,
  CancelTaskRequest,
} from "./types.js";
import {
  taskIdFromStreamResponse,
  validateAgentCard,
  validateCancelTaskRequest,
  validateGetTaskRequest,
  validateListTasksRequest,
  validateListTasksResponse,
  validateSendMessageRequest,
  validateSendMessageResult,
  validateStreamResponse,
  validateSubscribeToTaskRequest,
  validateTask,
} from "./validation.js";

const defaultClock: Clock = { now: () => Date.now() };

type RuntimeOptions = Omit<StrictClientOptions, "agentUrl"> & {
  readonly agentUrl: string | URL;
  readonly fetchImpl: typeof fetch;
  readonly clockImpl: Clock;
  readonly timeout: number;
  readonly responseLimit: number;
  readonly redirectLimit: number;
  readonly requested: readonly string[];
  readonly cacheImpl: NonNullable<StrictClientOptions["cache"]>;
  readonly urlPolicyImpl: NonNullable<StrictClientOptions["urlPolicy"]>;
};

type ConnectedState = {
  readonly card: AgentCard;
  readonly connection: ConnectionMetadata;
  readonly sdkClient: SdkClient;
};

export async function connectA2aClient(options: StrictClientOptions): Promise<A2aClient> {
  const client = new StrictA2aClient(normalizeOptions(options));
  await client.connect();
  return client;
}

class StrictA2aClient implements A2aClient {
  readonly #options: RuntimeOptions;
  #state?: ConnectedState;

  constructor(options: RuntimeOptions) {
    this.#options = options;
  }

  get connection(): ConnectionMetadata {
    return structuredClone(this.requireState().connection);
  }

  async connect(): Promise<void> {
    this.#state = await this.createState(false, this.#options.signal);
  }

  getAgentCard(): AgentCard {
    return structuredClone(this.requireState().card);
  }

  async refreshAgentCard(options?: RequestOptions): Promise<AgentCard> {
    return this.execute("discover", async () => {
      this.#state = await this.createState(true, options?.signal);
      return this.getAgentCard();
    });
  }

  async getExtendedAgentCard(options?: RequestOptions): Promise<AgentCard> {
    const state = this.requireState();
    if (!state.card.capabilities.extendedAgentCard) {
      throw new A2aClientError("UNSUPPORTED_CAPABILITY", "Agent does not declare extended Agent Card support", {
        operation: "getExtendedAgentCard",
      });
    }
    return this.execute("getExtendedAgentCard", async () => {
      const result = await state.sdkClient.getAgentCard(this.sdkOptions(options));
      const card = validateAgentCard(SdkAgentCard.toJSON(result));
      await verifyCardTrust(card, this.#options.signatureTrustStore);
      return card;
    });
  }

  async sendMessage(request: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult> {
    const validated = validateSendMessageRequest(request, "sendMessage");
    return this.execute("sendMessage", async () => {
      const result = await this.requireState().sdkClient.sendMessage(
        SdkSendMessageRequest.fromJSON(validated),
        this.sdkOptions(options),
      );
      const json = "status" in result ? SdkTask.toJSON(result) : SdkMessage.toJSON(result);
      const validatedResult = validateSendMessageResult(json, "sendMessage");
      assertMessageCorrelation(validated, validatedResult);
      return validatedResult;
    });
  }

  async *sendStreamingMessage(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncIterable<StreamResponse> {
    const state = this.requireState();
    if (!state.card.capabilities.streaming) {
      throw new A2aClientError("UNSUPPORTED_CAPABILITY", "Agent does not declare streaming support", {
        operation: "sendStreamingMessage",
      });
    }
    const validated = validateSendMessageRequest(request, "sendStreamingMessage");
    try {
      for await (const sdkEvent of state.sdkClient.sendMessageStream(
        SdkSendMessageRequest.fromJSON(validated),
        this.sdkOptions(options),
      )) {
        const event = validateStreamResponse(SdkStreamResponse.toJSON(sdkEvent), "sendStreamingMessage");
        await this.emitStream("sendStreamingMessage", event);
        yield event;
        if (isTerminalStreamEvent(event)) return;
      }
    } catch (error) {
      throw await this.recordError(error, "sendStreamingMessage");
    }
  }

  async getTask(request: GetTaskRequest, options?: RequestOptions): Promise<Task> {
    const validatedRequest = validateGetTaskRequest(request);
    return this.execute("getTask", async () => {
      const result = await this.requireState().sdkClient.getTask(
        SdkGetTaskRequest.fromJSON(validatedRequest),
        this.sdkOptions(options),
      );
      const task = validateTask(SdkTask.toJSON(result), "getTask");
      assertTaskId(task.id, validatedRequest.id, "getTask");
      return task;
    });
  }

  async listTasks(request: ListTasksRequest = {}, options?: RequestOptions): Promise<ListTasksResponse> {
    const validatedRequest = validateListTasksRequest(request);
    return this.execute("listTasks", async () => {
      const result = await this.requireState().sdkClient.listTasks(
        SdkListTasksRequest.fromJSON(validatedRequest),
        this.sdkOptions(options),
      );
      return validateListTasksResponse(SdkListTasksResponse.toJSON(result), "listTasks");
    });
  }

  async cancelTask(request: CancelTaskRequest, options?: RequestOptions): Promise<Task> {
    const validatedRequest = validateCancelTaskRequest(request);
    return this.execute("cancelTask", async () => {
      const result = await this.requireState().sdkClient.cancelTask(
        SdkCancelTaskRequest.fromJSON(validatedRequest),
        this.sdkOptions(options),
      );
      const task = validateTask(SdkTask.toJSON(result), "cancelTask");
      assertTaskId(task.id, validatedRequest.id, "cancelTask");
      return task;
    });
  }

  async *subscribeToTask(
    request: SubscribeToTaskRequest,
    options?: RequestOptions,
  ): AsyncIterable<StreamResponse> {
    const validatedRequest = validateSubscribeToTaskRequest(request);
    const state = this.requireState();
    if (!state.card.capabilities.streaming) {
      throw new A2aClientError("UNSUPPORTED_CAPABILITY", "Agent does not declare streaming support", {
        operation: "subscribeToTask",
      });
    }
    let first = true;
    try {
      for await (const sdkEvent of state.sdkClient.resubscribeTask(
        SdkSubscribeToTaskRequest.fromJSON(validatedRequest),
        this.sdkOptions(options),
      )) {
        const event = validateStreamResponse(SdkStreamResponse.toJSON(sdkEvent), "subscribeToTask");
        if (first && !("task" in event && event.task)) {
          throw new A2aClientError("STREAM_INVALID", "SubscribeToTask first event must be a Task", {
            operation: "subscribeToTask",
          });
        }
        first = false;
        const eventTaskId = taskIdFromStreamResponse(event);
        if (eventTaskId) assertTaskId(eventTaskId, validatedRequest.id, "subscribeToTask");
        await this.emitStream("subscribeToTask", event);
        yield event;
        if (isTerminalStreamEvent(event)) return;
      }
      if (first) {
        throw new A2aClientError("STREAM_INVALID", "SubscribeToTask returned no initial Task", {
          operation: "subscribeToTask",
        });
      }
    } catch (error) {
      throw await this.recordError(error, "subscribeToTask");
    }
  }

  async createState(forceRefresh: boolean, signal?: AbortSignal): Promise<ConnectedState> {
    const discovered = await discoverAgentCard({
      agentUrl: this.#options.agentUrl,
      agentCardPath: this.#options.agentCardPath,
      cache: this.#options.cacheImpl,
      trustStore: this.#options.signatureTrustStore,
      fetchImpl: this.#options.fetchImpl,
      clock: this.#options.clockImpl,
      urlPolicy: this.#options.urlPolicyImpl,
      evidenceSink: this.#options.evidenceSink,
      timeoutMs: this.#options.timeout,
      maxResponseBytes: this.#options.responseLimit,
      maxRedirects: this.#options.redirectLimit,
      forceRefresh,
      signal,
    });
    const negotiation = await negotiateConnection(
      discovered.card,
      this.#options.requested,
      this.#options.urlPolicyImpl,
    );
    const securityRequirement = selectSecurityRequirement(
      discovered.card,
      this.#options.credentialProvider,
    );
    const sdkFetch = createPolicyFetch({
      fetchImpl: this.#options.fetchImpl,
      urlPolicy: this.#options.urlPolicyImpl,
      evidenceSink: this.#options.evidenceSink,
      credentialProvider: this.#options.credentialProvider,
      credentialContext: { agentCard: discovered.card, requirement: securityRequirement },
      operation: "sendMessage",
      binding: negotiation.selectedInterface.protocolBinding,
      purpose: "operation",
      timeoutMs: this.#options.timeout,
      maxResponseBytes: this.#options.responseLimit,
      maxRedirects: this.#options.redirectLimit,
    });
    const factory = new ClientFactory({
      transports: transportFactories(negotiation.selectedInterface.protocolBinding, sdkFetch),
      clientConfig: { polling: true },
    });
    const narrowedCard = SdkAgentCard.fromJSON({
      ...discovered.card,
      supportedInterfaces: [negotiation.selectedInterface],
    });
    const sdkClient = await factory.createFromAgentCard(narrowedCard);
    const connection: ConnectionMetadata = {
      cardUrl: discovered.cardUrl,
      selectedInterface: negotiation.selectedInterface,
      protocolVersion: "1.0",
      negotiatedExtensions: negotiation.negotiatedExtensions,
      securityRequirement,
      trust: discovered.trust,
      cache: discovered.cache,
    };
    await emitEvidence(this.#options.evidenceSink, {
      kind: "decision",
      operation: "discover",
      binding: connection.selectedInterface.protocolBinding,
      url: connection.selectedInterface.url,
      details: connection,
    });
    return { card: discovered.card, connection, sdkClient };
  }

  sdkOptions(options?: RequestOptions): SdkRequestOptions {
    const extensions = this.requireState().connection.negotiatedExtensions;
    const serviceParameters = extensions.length > 0
      ? ServiceParameters.create(withA2AExtensions(...extensions))
      : ServiceParameters.create();
    return { signal: options?.signal, serviceParameters };
  }

  async execute<T>(operation: OperationName, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw await this.recordError(error, operation);
    }
  }

  async recordError(error: unknown, operation: OperationName): Promise<A2aClientError> {
    const mapped = mapSdkError(error, operation);
    await emitEvidence(this.#options.evidenceSink, {
      kind: "error",
      operation,
      binding: this.#state?.connection.selectedInterface.protocolBinding,
      url: this.#state?.connection.selectedInterface.url,
      details: { code: mapped.code, message: mapped.message, retryable: mapped.retryable },
    });
    return mapped;
  }

  async emitStream(operation: "sendStreamingMessage" | "subscribeToTask", event: StreamResponse): Promise<void> {
    const connection = this.requireState().connection;
    await emitEvidence(this.#options.evidenceSink, {
      kind: "stream",
      operation,
      binding: connection.selectedInterface.protocolBinding,
      url: connection.selectedInterface.url,
      details: event,
    });
  }

  requireState(): ConnectedState {
    if (!this.#state) {
      throw new A2aClientError("PROTOCOL_VIOLATION", "Client has not connected", {
        operation: "discover",
      });
    }
    return this.#state;
  }
}

function normalizeOptions(options: StrictClientOptions): RuntimeOptions {
  if (!options || !options.agentUrl) {
    throw new A2aClientError("URL_POLICY_REJECTED", "agentUrl is required", { operation: "discover" });
  }
  return {
    ...options,
    fetchImpl: options.fetch ?? fetch,
    clockImpl: options.clock ?? defaultClock,
    timeout: positiveInteger(options.timeoutMs, 30_000, "timeoutMs"),
    responseLimit: positiveInteger(options.maxResponseBytes, 10 * 1024 * 1024, "maxResponseBytes"),
    redirectLimit: nonNegativeInteger(options.maxRedirects, 3, "maxRedirects"),
    requested: [...new Set(options.requestedExtensions ?? [])],
    cacheImpl: options.cache ?? new MemoryAgentCardCache(),
    urlPolicyImpl: options.urlPolicy ?? new DefaultUrlPolicy({ allowLocalhost: options.allowLocalhost }),
  };
}

function transportFactories(binding: "JSONRPC" | "HTTP+JSON", fetchImpl: typeof fetch): TransportFactory[] {
  switch (binding) {
    case "JSONRPC":
      return [new JsonRpcTransportFactory({ fetchImpl })];
    case "HTTP+JSON":
      return [new RestTransportFactory({ fetchImpl })];
    default: {
      const exhaustive: never = binding;
      throw new Error(`Unsupported binding: ${exhaustive}`);
    }
  }
}

function mapSdkError(error: unknown, operation: OperationName): A2aClientError {
  if (error instanceof A2aClientError) return error;
  const name = error instanceof Error ? error.name || error.constructor.name : "";
  const message = error instanceof Error ? error.message : "Remote A2A operation failed";
  if (/response id mismatch/i.test(message)) {
    return new A2aClientError("RESPONSE_ID_MISMATCH", message, { operation, cause: error });
  }
  const byName: Readonly<Record<string, { code: ConstructorParameters<typeof A2aClientError>[0]; retryable?: boolean }>> = {
    VersionNotSupportedError: { code: "VERSION_NOT_SUPPORTED" },
    TaskNotFoundError: { code: "TASK_NOT_FOUND" },
    TaskNotCancelableError: { code: "TASK_NOT_CANCELABLE" },
    UnsupportedOperationError: { code: "UNSUPPORTED_CAPABILITY" },
    ExtendedAgentCardNotConfiguredError: { code: "UNSUPPORTED_CAPABILITY" },
    InvalidAgentResponseError: { code: "PROTOCOL_VIOLATION" },
    RequestMalformedError: { code: "PROTOCOL_VIOLATION" },
    ContentTypeNotSupportedError: { code: "PROTOCOL_VIOLATION" },
  };
  const mapped = byName[name];
  if (mapped) {
    return new A2aClientError(mapped.code, message, { operation, retryable: mapped.retryable, cause: error });
  }
  if (/aborted|aborterror/i.test(`${name} ${message}`)) {
    return new A2aClientError("ABORTED", `${operation} was aborted`, { operation, cause: error });
  }
  if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) {
    return new A2aClientError("AUTHENTICATION_FAILED", "A2A authentication failed", {
      operation,
      cause: error,
    });
  }
  return asA2aClientError(error, operation);
}

function assertTaskId(actual: string, expected: string, operation: OperationName): void {
  if (actual !== expected) {
    throw new A2aClientError("PROTOCOL_VIOLATION", `${operation} returned task ${actual}; expected ${expected}`, {
      operation,
      details: { expected, actual },
    });
  }
}

function assertMessageCorrelation(request: SendMessageRequest, result: SendMessageResult): void {
  const expectedTaskId = request.message.taskId;
  const expectedContextId = request.message.contextId;
  const candidate = result as {
    readonly id?: unknown;
    readonly status?: unknown;
    readonly taskId?: unknown;
    readonly contextId?: unknown;
  };
  const actualTaskId = candidate.status !== undefined && typeof candidate.id === "string"
    ? candidate.id
    : typeof candidate.taskId === "string"
      ? candidate.taskId
      : undefined;
  const actualContextId = typeof candidate.contextId === "string" ? candidate.contextId : undefined;
  if (expectedTaskId && actualTaskId && actualTaskId !== expectedTaskId) {
    assertTaskId(actualTaskId, expectedTaskId, "sendMessage");
  }
  if (expectedContextId && actualContextId && actualContextId !== expectedContextId) {
    throw new A2aClientError("PROTOCOL_VIOLATION", "sendMessage response contextId did not match the request", {
      operation: "sendMessage",
      details: { expected: expectedContextId, actual: actualContextId },
    });
  }
}

const TERMINAL_TASK_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

function isTerminalStreamEvent(event: StreamResponse): boolean {
  if ("task" in event && event.task) return TERMINAL_TASK_STATES.has(event.task.status.state);
  return "statusUpdate" in event && event.statusUpdate
    ? TERMINAL_TASK_STATES.has(event.statusUpdate.status.state)
    : false;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new A2aClientError("PROTOCOL_VIOLATION", `${name} must be a positive integer`, {
      operation: "discover",
    });
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new A2aClientError("PROTOCOL_VIOLATION", `${name} must be a non-negative integer`, {
      operation: "discover",
    });
  }
  return value;
}
