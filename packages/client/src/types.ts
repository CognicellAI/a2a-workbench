export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type Metadata = Readonly<Record<string, JsonValue>>;

export const SUPPORTED_BINDINGS = ["JSONRPC", "HTTP+JSON"] as const;
export type SupportedBinding = (typeof SUPPORTED_BINDINGS)[number];

export type AgentInterface = {
  readonly url: string;
  readonly protocolBinding: string;
  readonly protocolVersion: string;
  readonly tenant?: string;
  readonly [key: string]: unknown;
};

export type AgentExtension = {
  readonly uri: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly params?: Metadata;
  readonly [key: string]: unknown;
};

export type AgentCapabilities = {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
  readonly extendedAgentCard?: boolean;
  readonly extensions?: readonly AgentExtension[];
  readonly [key: string]: unknown;
};

export type ApiKeySecurityScheme = {
  readonly apiKeySecurityScheme: {
    readonly description?: string;
    readonly location: "header" | "query" | "cookie" | string;
    readonly name: string;
  };
};

export type HttpAuthSecurityScheme = {
  readonly httpAuthSecurityScheme: {
    readonly description?: string;
    readonly scheme: string;
    readonly bearerFormat?: string;
  };
};

export type ClientCredentialsFlow = {
  readonly tokenUrl: string;
  readonly refreshUrl?: string;
  readonly scopes?: Readonly<Record<string, string>>;
};

export type OAuth2SecurityScheme = {
  readonly oauth2SecurityScheme: {
    readonly description?: string;
    readonly oauth2MetadataUrl?: string;
    readonly flows?: {
      readonly clientCredentials?: ClientCredentialsFlow;
      readonly [key: string]: unknown;
    };
  };
};

export type OpenIdConnectSecurityScheme = {
  readonly openIdConnectSecurityScheme: {
    readonly description?: string;
    readonly openIdConnectUrl: string;
  };
};

export type MutualTlsSecurityScheme = {
  readonly mtlsSecurityScheme: {
    readonly description?: string;
  };
};

export type SecurityScheme =
  | ApiKeySecurityScheme
  | HttpAuthSecurityScheme
  | OAuth2SecurityScheme
  | OpenIdConnectSecurityScheme
  | MutualTlsSecurityScheme;

export type SecurityRequirement = {
  readonly schemes: Readonly<Record<string, { readonly list: readonly string[] }>>;
};

export type AgentCardSignature = {
  readonly protected: string;
  readonly signature: string;
  readonly header?: Metadata;
};

export type AgentSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
  readonly securityRequirements?: readonly SecurityRequirement[];
  readonly [key: string]: unknown;
};

export type AgentCard = {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly supportedInterfaces: readonly AgentInterface[];
  readonly capabilities: AgentCapabilities;
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  readonly securityRequirements?: readonly SecurityRequirement[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly AgentSkill[];
  readonly signatures?: readonly AgentCardSignature[];
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  readonly provider?: {
    readonly organization: string;
    readonly url: string;
  };
  readonly [key: string]: unknown;
};

type PartCommon = {
  readonly metadata?: Metadata;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly [key: string]: unknown;
};

export type TextPart = PartCommon & {
  readonly text: string;
  readonly raw?: never;
  readonly url?: never;
  readonly data?: never;
};
export type RawPart = PartCommon & {
  readonly raw: string;
  readonly text?: never;
  readonly url?: never;
  readonly data?: never;
};
export type UrlPart = PartCommon & {
  readonly url: string;
  readonly text?: never;
  readonly raw?: never;
  readonly data?: never;
};
export type DataPart = PartCommon & {
  readonly data: JsonValue;
  readonly text?: never;
  readonly raw?: never;
  readonly url?: never;
};
export type Part = TextPart | RawPart | UrlPart | DataPart;

export type Role = "ROLE_USER" | "ROLE_AGENT";

export type Message = {
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId?: string;
  readonly role: Role;
  readonly parts: readonly Part[];
  readonly metadata?: Metadata;
  readonly extensions?: readonly string[];
  readonly referenceTaskIds?: readonly string[];
  readonly [key: string]: unknown;
};

export const KNOWN_TASK_STATES = [
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type KnownTaskState = (typeof KNOWN_TASK_STATES)[number];
export type TaskState = KnownTaskState | (string & {});

export type TaskStatus = {
  readonly state: TaskState;
  readonly message?: Message;
  readonly timestamp?: string;
};

export type Artifact = {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly Part[];
  readonly metadata?: Metadata;
  readonly extensions?: readonly string[];
  readonly [key: string]: unknown;
};

export type Task = {
  readonly id: string;
  readonly contextId: string;
  readonly status: TaskStatus;
  readonly artifacts?: readonly Artifact[];
  readonly history?: readonly Message[];
  readonly metadata?: Metadata;
  readonly [key: string]: unknown;
};

export type SendMessageConfiguration = {
  readonly acceptedOutputModes?: readonly string[];
  readonly historyLength?: number;
  readonly returnImmediately?: boolean;
};

export type SendMessageRequest = {
  readonly message: Message;
  readonly configuration?: SendMessageConfiguration;
  readonly metadata?: Metadata;
};

export type GetTaskRequest = { readonly id: string; readonly historyLength?: number };
export type ListTasksRequest = {
  readonly contextId?: string;
  readonly status?: TaskState;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly historyLength?: number;
  readonly statusTimestampAfter?: string;
  readonly includeArtifacts?: boolean;
};
export type ListTasksResponse = {
  readonly tasks: readonly Task[];
  readonly nextPageToken?: string;
  readonly pageSize: number;
  readonly totalSize: number;
};
export type CancelTaskRequest = { readonly id: string; readonly metadata?: Metadata };
export type SubscribeToTaskRequest = { readonly id: string };
export type SendMessageResult = Message | Task;

export type TaskStatusUpdateEvent = {
  readonly taskId: string;
  readonly contextId: string;
  readonly status: TaskStatus;
  readonly metadata?: Metadata;
};
export type TaskArtifactUpdateEvent = {
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact: Artifact;
  readonly append?: boolean;
  readonly lastChunk?: boolean;
  readonly metadata?: Metadata;
};

export type StreamResponse =
  | { readonly task: Task; readonly message?: never; readonly statusUpdate?: never; readonly artifactUpdate?: never }
  | { readonly task?: never; readonly message: Message; readonly statusUpdate?: never; readonly artifactUpdate?: never }
  | { readonly task?: never; readonly message?: never; readonly statusUpdate: TaskStatusUpdateEvent; readonly artifactUpdate?: never }
  | { readonly task?: never; readonly message?: never; readonly statusUpdate?: never; readonly artifactUpdate: TaskArtifactUpdateEvent };

export type RequestOptions = {
  readonly signal?: AbortSignal;
};

export type CardTrustState = "unsigned" | "verified";
export type CardCacheState = "miss" | "fresh" | "revalidated" | "refreshed";

export type ConnectionMetadata = {
  readonly cardUrl: string;
  readonly selectedInterface: AgentInterface & { readonly protocolBinding: SupportedBinding };
  readonly protocolVersion: "1.0";
  readonly negotiatedExtensions: readonly string[];
  readonly securityRequirement?: SecurityRequirement;
  readonly trust: CardTrustState;
  readonly cache: CardCacheState;
};

export type OperationName =
  | "discover"
  | "getExtendedAgentCard"
  | "sendMessage"
  | "sendStreamingMessage"
  | "getTask"
  | "listTasks"
  | "cancelTask"
  | "subscribeToTask";

export type EvidenceKind = "decision" | "request" | "response" | "stream" | "error";
export type EvidenceEvent = {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: EvidenceKind;
  readonly operation: OperationName;
  readonly binding?: SupportedBinding;
  readonly url?: string;
  readonly details: unknown;
};

export interface EvidenceSink {
  emit(event: EvidenceEvent): void | Promise<void>;
}

export interface Clock {
  now(): number;
}

export type UrlPolicyContext = {
  readonly purpose: "discovery" | "operation" | "oauth" | "trust";
  readonly redirectFrom?: URL;
};

export interface UrlPolicy {
  assertAllowed(url: URL, context: UrlPolicyContext): void | Promise<void>;
}

export type CachedAgentCard = {
  readonly card: AgentCard;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly mustRevalidate: boolean;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly trust: CardTrustState;
};

export interface AgentCardCache {
  get(cardUrl: string): Promise<CachedAgentCard | undefined>;
  set(cardUrl: string, value: CachedAgentCard): Promise<void>;
  delete(cardUrl: string): Promise<void>;
}

export type SignatureKey = CryptoKey | JsonWebKey;
export interface SignatureTrustStore {
  resolve(kid: string, jku?: string): Promise<SignatureKey>;
}

export type CredentialRequest = {
  readonly operation: OperationName;
  readonly agentCard: AgentCard;
  readonly requirement?: SecurityRequirement;
  readonly signal?: AbortSignal;
};

export interface CredentialProvider {
  canProvide(schemeName: string, scheme: SecurityScheme, scopes: readonly string[]): boolean;
  getHeaders(request: CredentialRequest): Promise<Readonly<Record<string, string>>>;
}

export type ApiKeyCredential = { readonly type: "apiKey"; readonly value: string };
export type BasicCredential = { readonly type: "basic"; readonly username: string; readonly password: string };
export type BearerCredential = { readonly type: "bearer"; readonly token: string };
export type OAuth2ClientCredential = {
  readonly type: "oauth2ClientCredentials";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl?: string;
  readonly authMethod?: "client_secret_basic" | "client_secret_post";
  readonly audience?: string;
};
export type CustomHeadersCredential = {
  readonly type: "customHeaders";
  readonly headers: Readonly<Record<string, string>>;
};
export type Credential =
  | ApiKeyCredential
  | BasicCredential
  | BearerCredential
  | OAuth2ClientCredential
  | CustomHeadersCredential;

export type StaticCredentialProviderOptions = {
  readonly fetch?: typeof fetch;
  readonly urlPolicy?: UrlPolicy;
  readonly clock?: Clock;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
};

export type StrictClientOptions = {
  readonly agentUrl: string | URL;
  readonly signal?: AbortSignal;
  readonly agentCardPath?: string;
  readonly requestedExtensions?: readonly string[];
  readonly credentialProvider?: CredentialProvider;
  readonly cache?: AgentCardCache;
  readonly signatureTrustStore?: SignatureTrustStore;
  readonly urlPolicy?: UrlPolicy;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  readonly evidenceSink?: EvidenceSink;
  readonly allowLocalhost?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
};

export interface A2aClient {
  readonly connection: ConnectionMetadata;
  getAgentCard(): AgentCard;
  refreshAgentCard(options?: RequestOptions): Promise<AgentCard>;
  getExtendedAgentCard(options?: RequestOptions): Promise<AgentCard>;
  sendMessage(request: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult>;
  sendStreamingMessage(request: SendMessageRequest, options?: RequestOptions): AsyncIterable<StreamResponse>;
  getTask(request: GetTaskRequest, options?: RequestOptions): Promise<Task>;
  listTasks(request?: ListTasksRequest, options?: RequestOptions): Promise<ListTasksResponse>;
  cancelTask(request: CancelTaskRequest, options?: RequestOptions): Promise<Task>;
  subscribeToTask(request: SubscribeToTaskRequest, options?: RequestOptions): AsyncIterable<StreamResponse>;
}
