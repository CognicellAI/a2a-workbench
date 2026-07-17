export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HeaderInput = {
  name?: unknown;
  value?: unknown;
  enabled?: unknown;
  secret?: unknown;
};

export type ConnectionProfileInput = {
  upstream?: unknown;
  mode?: unknown;
  binding?: unknown;
  a2uiTrigger?: unknown;
  headers?: unknown;
  oauth?: unknown;
};

export type WorkbenchMode = "strict" | "compatibility";
export type WorkbenchOperation =
  | "connect"
  | "sendMessage"
  | "sendStreamingMessage"
  | "getTask"
  | "listTasks"
  | "cancelTask"
  | "subscribeToTask"
  | "getExtendedAgentCard";

export const WORKBENCH_PART_KINDS = ["text", "data", "raw", "url"] as const;
export type WorkbenchPartKind = (typeof WORKBENCH_PART_KINDS)[number];

/**
 * Untrusted browser input for one A2A v1 Part. The route validates this before
 * constructing the package's public `Part` union.
 */
export type WorkbenchPartInput = {
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly raw?: unknown;
  readonly url?: unknown;
  readonly mediaType?: unknown;
  readonly filename?: unknown;
  readonly metadata?: unknown;
};

/**
 * Untrusted browser input for the message portion of a strict send operation.
 * Compatibility mode accepts only the legacy text `message` field.
 */
export type WorkbenchMessageInput = {
  readonly messageId?: unknown;
  readonly contextId?: unknown;
  readonly taskId?: unknown;
  readonly parts?: unknown;
  readonly metadata?: unknown;
  readonly extensions?: unknown;
  readonly referenceTaskIds?: unknown;
};

export type M2mOAuthAuthMethod = "client_secret_basic" | "client_secret_post";

export type M2mOAuthInput = {
  enabled?: unknown;
  tokenUrl?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  scope?: unknown;
  audience?: unknown;
  authMethod?: unknown;
};

export type NormalizedM2mOAuth = {
  enabled: boolean;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  authMethod: M2mOAuthAuthMethod;
};

export type NormalizedHeader = {
  name: string;
  value: string;
  enabled: boolean;
  secret: boolean;
};

export type NormalizedConnection = {
  upstream: string;
  a2uiTrigger: string;
  headers: NormalizedHeader[];
  oauth?: NormalizedM2mOAuth;
};

export type SseFrame = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

export type A2aMeta = {
  id?: string;
  taskId?: string;
  contextId?: string;
  kind?: string;
  final?: boolean;
  status?: string;
};

export type A2aStatus = {
  state: string;
  final?: boolean;
  message?: string;
};

export type WorkbenchError = {
  message: string;
  code?: string;
  detail?: unknown;
  status?: number;
};

export type WorkbenchEvent =
  | { type: "request"; data: unknown }
  | { type: "connection"; data: unknown }
  | { type: "agent-card"; data: unknown }
  | { type: "evidence"; data: unknown }
  | { type: "raw"; data: SseFrame }
  | { type: "a2a"; data: unknown }
  | { type: "meta"; data: A2aMeta }
  | { type: "status"; data: A2aStatus }
  | { type: "text"; data: { text: string } }
  | { type: "a2ui"; data: { messages: unknown[]; source: string } }
  | { type: "error"; data: WorkbenchError }
  | { type: "done"; data: { ok: boolean } };

export type WorkbenchEventType = WorkbenchEvent["type"];

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type PersistedHeader = {
  name: string;
  value: string;
  enabled: boolean;
  secret: boolean;
};

export type PersistedM2mOAuth = {
  enabled: boolean;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  authMethod: M2mOAuthAuthMethod;
};

export type PersistedConnection = {
  upstream: string;
  mode: WorkbenchMode;
  binding: "JSONRPC" | "HTTP+JSON";
  a2uiTrigger: string;
  headers: PersistedHeader[];
  oauth: PersistedM2mOAuth;
};
