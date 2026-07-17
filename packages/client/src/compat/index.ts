import {
  AgentCard as SdkAgentCard,
  Message as SdkMessage,
  SendMessageRequest as SdkSendMessageRequest,
  StreamResponse as SdkStreamResponse,
  Task as SdkTask,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client as SdkClient,
  type TransportFactory,
} from "@a2a-js/sdk/client";
import { A2aClientError, asA2aClientError } from "../errors.js";
import { DefaultUrlPolicy, createPolicyFetch } from "../network.js";
import type {
  EvidenceSink,
  RequestOptions,
  SendMessageRequest,
  SendMessageResult,
  StreamResponse,
  SupportedBinding,
  UrlPolicy,
} from "../types.js";
import {
  validateSendMessageRequest,
  validateSendMessageResult,
  validateStreamResponse,
} from "../validation.js";

type LegacyCommonOptions = {
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly urlPolicy?: UrlPolicy;
  readonly evidenceSink?: EvidenceSink;
  readonly allowLocalhost?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
};

export type LegacyClientOptions = LegacyCommonOptions & (
  | {
      readonly mode: "direct";
      readonly endpoint: string | URL;
      readonly binding: SupportedBinding;
    }
  | {
      readonly mode: "discovery";
      readonly agentUrl: string | URL;
      readonly agentCardPath?: string;
    }
);

export type LegacyConnectionMetadata = {
  readonly mode: "compatibility";
  readonly protocolVersion: "0.3";
  readonly endpoint: string;
  readonly binding?: SupportedBinding;
};

export interface LegacyA2aClient {
  readonly connection: LegacyConnectionMetadata;
  sendMessage(request: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult>;
  sendStreamingMessage(request: SendMessageRequest, options?: RequestOptions): AsyncIterable<StreamResponse>;
}

export async function connectLegacyClient(options: LegacyClientOptions): Promise<LegacyA2aClient> {
  const fetchImpl = options.fetch ?? fetch;
  const urlPolicy = options.urlPolicy ?? new DefaultUrlPolicy({ allowLocalhost: options.allowLocalhost });
  const policyFetch = createPolicyFetch({
    fetchImpl: withDefaultHeaders(fetchImpl, options.headers ?? {}),
    urlPolicy,
    evidenceSink: options.evidenceSink,
    operation: "sendMessage",
    purpose: "operation",
    timeoutMs: options.timeoutMs ?? 30_000,
    maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
    maxRedirects: options.maxRedirects ?? 3,
  });
  const transports = legacyFactories(policyFetch);
  const factory = new ClientFactory({
    transports,
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: policyFetch,
      legacyCompat: { enabled: true },
    }),
    clientConfig: { polling: true },
  });

  if (options.mode === "discovery") {
    const sdkClient = await factory.createFromUrl(String(options.agentUrl), options.agentCardPath);
    return new LegacyClient(sdkClient, {
      mode: "compatibility",
      protocolVersion: "0.3",
      endpoint: String(options.agentUrl),
    });
  }

  const endpoint = new URL(options.endpoint);
  await urlPolicy.assertAllowed(endpoint, { purpose: "operation" });
  const syntheticCard = SdkAgentCard.fromJSON({
    name: "Direct compatibility endpoint",
    description: "Synthetic card for an explicitly configured v0.3 endpoint",
    version: "0.3",
    supportedInterfaces: [{
      url: endpoint.href,
      protocolBinding: options.binding,
      protocolVersion: "0.3",
    }],
    capabilities: { streaming: true, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
  });
  const sdkClient = await factory.createFromAgentCard(syntheticCard);
  return new LegacyClient(sdkClient, {
    mode: "compatibility",
    protocolVersion: "0.3",
    endpoint: endpoint.href,
    binding: options.binding,
  });
}

class LegacyClient implements LegacyA2aClient {
  readonly #client: SdkClient;
  readonly connection: LegacyConnectionMetadata;

  constructor(client: SdkClient, connection: LegacyConnectionMetadata) {
    this.#client = client;
    this.connection = connection;
  }

  async sendMessage(request: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult> {
    try {
      const validated = validateSendMessageRequest(request, "sendMessage");
      const result = await this.#client.sendMessage(SdkSendMessageRequest.fromJSON(validated), {
        signal: options?.signal,
      });
      const json = "status" in result ? SdkTask.toJSON(result) : SdkMessage.toJSON(result);
      return validateSendMessageResult(normalizeLegacyResult(json), "sendMessage");
    } catch (error) {
      throw asA2aClientError(error, "sendMessage");
    }
  }

  async *sendStreamingMessage(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncIterable<StreamResponse> {
    try {
      const validated = validateSendMessageRequest(request, "sendStreamingMessage");
      for await (const sdkEvent of this.#client.sendMessageStream(SdkSendMessageRequest.fromJSON(validated), {
        signal: options?.signal,
      })) {
        yield validateStreamResponse(SdkStreamResponse.toJSON(sdkEvent), "sendStreamingMessage");
      }
    } catch (error) {
      if (error instanceof A2aClientError) throw error;
      throw asA2aClientError(error, "sendStreamingMessage");
    }
  }
}

function normalizeLegacyResult(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const normalized = { ...value };
  if (isRecord(normalized.status) && isRecord(normalized.status.message)) {
    normalized.status = { ...normalized.status, message: normalizeLegacyMessage(normalized.status.message) };
  }
  if (Array.isArray(normalized.history)) {
    normalized.history = normalized.history.map(normalizeLegacyMessage);
  }
  return normalizeLegacyMessage(normalized);
}

function normalizeLegacyMessage(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value;
  const { content, ...message } = value;
  return { ...message, parts: content.map(normalizeLegacyPart) };
}

function normalizeLegacyPart(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.text === "string") return { text: value.text };
  if (isRecord(value.data)) return { data: value.data };
  if (isRecord(value.file)) {
    const file = value.file;
    const mediaType = typeof file.mimeType === "string" ? { mediaType: file.mimeType } : {};
    if (typeof file.fileWithUri === "string") return { ...mediaType, url: file.fileWithUri };
    if (typeof file.fileWithBytes === "string") return { ...mediaType, raw: file.fileWithBytes };
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyFactories(fetchImpl: typeof fetch): TransportFactory[] {
  const legacyCompat = { enabled: true } as const;
  return [
    new JsonRpcTransportFactory({ fetchImpl, legacyCompat }),
    new RestTransportFactory({ fetchImpl, legacyCompat }),
  ];
}

function withDefaultHeaders(fetchImpl: typeof fetch, defaults: Readonly<Record<string, string>>): typeof fetch {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    Object.entries(defaults).forEach(([name, value]) => headers.set(name, value));
    return fetchImpl(new Request(request, { headers }));
  };
}
