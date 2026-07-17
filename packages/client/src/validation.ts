import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import schemaBundleSource from "./schema/a2a-v1.schema.json" with { type: "json" };
import { A2aClientError } from "./errors.js";
import type {
  AgentCard,
  AgentInterface,
  Artifact,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  OperationName,
  Part,
  SecurityRequirement,
  SendMessageRequest,
  SendMessageResult,
  SupportedBinding,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatus,
  TaskStatusUpdateEvent,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const schemaBundle = relaxUnknownFields(structuredClone(schemaBundleSource)) as JsonRecord;
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default as typeof import("ajv/dist/2020.js").default;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: isA2aTimestamp,
});

const schemaValidators = new Map<string, ValidateFunction>();

export function validateAgentCard(value: unknown): AgentCard {
  const normalized = normalizeSecurityScopeLists(value);
  validateSchema("Agent Card", normalized, "discover", "AGENT_CARD_INVALID");
  const card = record(normalized, "Agent Card", "discover");
  nonEmptyString(card.name, "Agent Card.name", "discover");
  string(card.description, "Agent Card.description", "discover");
  nonEmptyString(card.version, "Agent Card.version", "discover");
  const interfaces = array(card.supportedInterfaces, "Agent Card.supportedInterfaces", "discover");
  if (interfaces.length === 0) {
    invalid("Agent Card must declare at least one supported interface", "discover", "AGENT_CARD_INVALID");
  }
  interfaces.forEach((entry, index) => validateAgentInterface(entry, index));
  record(card.capabilities, "Agent Card.capabilities", "discover");
  stringArray(card.defaultInputModes, "Agent Card.defaultInputModes", "discover");
  stringArray(card.defaultOutputModes, "Agent Card.defaultOutputModes", "discover");
  array(card.skills, "Agent Card.skills", "discover").forEach((skill, index) => {
    const item = record(skill, `Agent Card.skills[${index}]`, "discover");
    nonEmptyString(item.id, `Agent Card.skills[${index}].id`, "discover");
    nonEmptyString(item.name, `Agent Card.skills[${index}].name`, "discover");
    string(item.description, `Agent Card.skills[${index}].description`, "discover");
    stringArray(item.tags, `Agent Card.skills[${index}].tags`, "discover");
  });

  const schemes = optionalRecord(card.securitySchemes, "Agent Card.securitySchemes", "discover");
  Object.entries(schemes ?? {}).forEach(([name, scheme]) => validateSecurityScheme(name, scheme));
  const requirements = optionalArray(card.securityRequirements, "Agent Card.securityRequirements", "discover");
  requirements?.forEach((requirement, index) => validateSecurityRequirement(requirement, index, schemes ?? {}));

  const signatures = optionalArray(card.signatures, "Agent Card.signatures", "discover");
  signatures?.forEach((signature, index) => {
    const item = record(signature, `Agent Card.signatures[${index}]`, "discover");
    nonEmptyString(item.protected, `Agent Card.signatures[${index}].protected`, "discover");
    nonEmptyString(item.signature, `Agent Card.signatures[${index}].signature`, "discover");
  });

  return structuredClone(normalized) as AgentCard;
}

export function validateSendMessageRequest(value: unknown, operation: OperationName): SendMessageRequest {
  validateSchema("Send Message Request", value, operation, "PROTOCOL_VIOLATION");
  const request = record(value, "SendMessageRequest", operation);
  validateMessage(request.message, operation, "request.message", "ROLE_USER");
  if (request.configuration !== undefined) {
    const configuration = record(request.configuration, "request.configuration", operation);
    if (configuration.historyLength !== undefined) {
      nonNegativeInteger(configuration.historyLength, "request.configuration.historyLength", operation);
    }
    if (configuration.acceptedOutputModes !== undefined) {
      stringArray(configuration.acceptedOutputModes, "request.configuration.acceptedOutputModes", operation);
    }
    if (configuration.returnImmediately !== undefined && typeof configuration.returnImmediately !== "boolean") {
      invalid("request.configuration.returnImmediately must be a boolean", operation);
    }
  }
  return structuredClone(value) as SendMessageRequest;
}

export function validateGetTaskRequest(value: unknown): GetTaskRequest {
  validateSchema("Get Task Request", value, "getTask", "PROTOCOL_VIOLATION");
  const request = record(value, "GetTaskRequest", "getTask");
  nonEmptyString(request.id, "GetTaskRequest.id", "getTask");
  if (request.historyLength !== undefined) {
    nonNegativeInteger(request.historyLength, "GetTaskRequest.historyLength", "getTask");
  }
  return structuredClone(value) as GetTaskRequest;
}

export function validateListTasksRequest(value: unknown): ListTasksRequest {
  validateSchema("List Tasks Request", value, "listTasks", "PROTOCOL_VIOLATION");
  const request = record(value, "ListTasksRequest", "listTasks");
  if (request.pageSize !== undefined &&
    (!Number.isInteger(request.pageSize) || (request.pageSize as number) < 1 || (request.pageSize as number) > 100)) {
    invalid("ListTasksRequest.pageSize must be between 1 and 100", "listTasks");
  }
  if (request.historyLength !== undefined) {
    nonNegativeInteger(request.historyLength, "ListTasksRequest.historyLength", "listTasks");
  }
  return structuredClone(value) as ListTasksRequest;
}

export function validateCancelTaskRequest(value: unknown): CancelTaskRequest {
  validateSchema("Cancel Task Request", value, "cancelTask", "PROTOCOL_VIOLATION");
  const request = record(value, "CancelTaskRequest", "cancelTask");
  nonEmptyString(request.id, "CancelTaskRequest.id", "cancelTask");
  return structuredClone(value) as CancelTaskRequest;
}

export function validateSubscribeToTaskRequest(value: unknown): SubscribeToTaskRequest {
  validateSchema("Subscribe To Task Request", value, "subscribeToTask", "PROTOCOL_VIOLATION");
  const request = record(value, "SubscribeToTaskRequest", "subscribeToTask");
  nonEmptyString(request.id, "SubscribeToTaskRequest.id", "subscribeToTask");
  return structuredClone(value) as SubscribeToTaskRequest;
}

export function validateSendMessageResult(value: unknown, operation: OperationName): SendMessageResult {
  const item = record(value, "SendMessageResult", operation);
  if ("status" in item) {
    return validateTask(value, operation);
  }
  return validateMessage(value, operation, "SendMessageResult") as Message;
}

export function validateTask(value: unknown, operation: OperationName): Task {
  validateSchema("Task", value, operation, "PROTOCOL_VIOLATION");
  const task = record(value, "Task", operation);
  nonEmptyString(task.id, "Task.id", operation);
  nonEmptyString(task.contextId, "Task.contextId", operation);
  validateTaskStatus(task.status, operation, "Task.status");
  optionalArray(task.artifacts, "Task.artifacts", operation)?.forEach((artifact, index) =>
    validateArtifact(artifact, operation, `Task.artifacts[${index}]`),
  );
  optionalArray(task.history, "Task.history", operation)?.forEach((message, index) =>
    validateMessage(message, operation, `Task.history[${index}]`),
  );
  return structuredClone(value) as Task;
}

export function validateListTasksResponse(value: unknown, operation: OperationName): ListTasksResponse {
  validateSchema("List Tasks Response", value, operation, "PROTOCOL_VIOLATION");
  const response = record(value, "ListTasksResponse", operation);
  array(response.tasks, "ListTasksResponse.tasks", operation).forEach((task) => validateTask(task, operation));
  nonNegativeInteger(response.pageSize, "ListTasksResponse.pageSize", operation);
  nonNegativeInteger(response.totalSize, "ListTasksResponse.totalSize", operation);
  if (response.nextPageToken !== undefined) {
    string(response.nextPageToken, "ListTasksResponse.nextPageToken", operation);
  }
  return structuredClone(value) as ListTasksResponse;
}

export function validateStreamResponse(value: unknown, operation: OperationName): StreamResponse {
  validateSchema("Stream Response", value, operation, "STREAM_INVALID");
  const response = record(value, "StreamResponse", operation);
  const cases = ["task", "message", "statusUpdate", "artifactUpdate"].filter(
    (key) => response[key] !== undefined,
  );
  if (cases.length !== 1) {
    invalid("StreamResponse must contain exactly one payload", operation, "STREAM_INVALID");
  }
  switch (cases[0]) {
    case "task":
      validateTask(response.task, operation);
      break;
    case "message":
      validateMessage(response.message, operation, "StreamResponse.message");
      break;
    case "statusUpdate":
      validateStatusUpdate(response.statusUpdate, operation);
      break;
    case "artifactUpdate":
      validateArtifactUpdate(response.artifactUpdate, operation);
      break;
    default:
      invalid("StreamResponse payload is unknown", operation, "STREAM_INVALID");
  }
  return structuredClone(value) as StreamResponse;
}

export function taskIdFromStreamResponse(value: StreamResponse): string | undefined {
  if ("task" in value && value.task) return value.task.id;
  if ("message" in value && value.message) return value.message.taskId;
  if ("statusUpdate" in value && value.statusUpdate) return value.statusUpdate.taskId;
  if ("artifactUpdate" in value && value.artifactUpdate) return value.artifactUpdate.taskId;
  return undefined;
}

export function validateRawProtocolRequest(
  value: unknown,
  binding: SupportedBinding,
  operation: OperationName,
): void {
  if (binding !== "JSONRPC") {
    if (operation === "sendMessage" || operation === "sendStreamingMessage") {
      validateSendMessageRequest(value, operation);
    }
    return;
  }
  const envelope = validateJsonRpcEnvelope(value, operation, "request");
  const expectedMethod: Partial<Record<OperationName, string>> = {
    sendMessage: "SendMessage",
    sendStreamingMessage: "SendStreamingMessage",
    getTask: "GetTask",
    listTasks: "ListTasks",
    cancelTask: "CancelTask",
    subscribeToTask: "SubscribeToTask",
    getExtendedAgentCard: "GetExtendedAgentCard",
  };
  if (envelope.method !== expectedMethod[operation]) {
    invalid(`JSON-RPC method ${String(envelope.method)} does not match ${operation}`, operation);
  }
  if (operation === "sendMessage" || operation === "sendStreamingMessage") {
    validateSendMessageRequest(envelope.params, operation);
  } else {
    record(envelope.params, "JSON-RPC params", operation);
  }
}

export function validateRawProtocolResponse(
  value: unknown,
  binding: SupportedBinding,
  operation: OperationName,
): void {
  const result = binding === "JSONRPC"
    ? validateJsonRpcEnvelope(value, operation, "response").result
    : value;
  if (result === undefined) return;
  switch (operation) {
    case "sendMessage": {
      const response = record(result, "SendMessageResponse", operation);
      const cases = ["task", "message"].filter((key) => response[key] !== undefined);
      if (cases.length !== 1) invalid("SendMessageResponse must contain exactly one payload", operation);
      validateSendMessageResult(response[cases[0]], operation);
      return;
    }
    case "getTask":
    case "cancelTask":
      validateTask(result, operation);
      return;
    case "listTasks":
      validateListTasksResponse(result, operation);
      return;
    case "getExtendedAgentCard":
      validateAgentCard(result);
      return;
    default:
      return;
  }
}

export function validateRawSsePayload(
  value: unknown,
  binding: SupportedBinding,
  operation: "sendStreamingMessage" | "subscribeToTask",
): void {
  if (binding === "JSONRPC") {
    const envelope = validateJsonRpcEnvelope(value, operation, "response");
    if (envelope.result !== undefined) validateStreamResponse(envelope.result, operation);
    return;
  }
  validateStreamResponse(value, operation);
}

function validateJsonRpcEnvelope(
  value: unknown,
  operation: OperationName,
  direction: "request" | "response",
): JsonRecord {
  const envelope = record(value, `JSON-RPC ${direction}`, operation);
  if (envelope.jsonrpc !== "2.0") invalid("JSON-RPC envelope must declare version 2.0", operation);
  if (typeof envelope.id !== "string" && typeof envelope.id !== "number") {
    invalid("JSON-RPC envelope must contain a string or number id", operation);
  }
  if (direction === "request") {
    nonEmptyString(envelope.method, "JSON-RPC request.method", operation);
    return envelope;
  }
  const cases = ["result", "error"].filter((key) => envelope[key] !== undefined);
  if (cases.length !== 1) invalid("JSON-RPC response must contain exactly one of result or error", operation);
  if (envelope.error !== undefined) {
    const error = record(envelope.error, "JSON-RPC error", operation);
    if (!Number.isInteger(error.code)) invalid("JSON-RPC error.code must be an integer", operation);
    string(error.message, "JSON-RPC error.message", operation);
  }
  return envelope;
}

function validateAgentInterface(value: unknown, index: number): asserts value is AgentInterface {
  const item = record(value, `Agent Card.supportedInterfaces[${index}]`, "discover");
  const url = nonEmptyString(item.url, `Agent Card.supportedInterfaces[${index}].url`, "discover");
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) throw new Error("not HTTP");
  } catch {
    invalid(`Agent interface URL is not an absolute HTTP(S) URL: ${url}`, "discover", "AGENT_CARD_INVALID");
  }
  nonEmptyString(item.protocolBinding, `Agent Card.supportedInterfaces[${index}].protocolBinding`, "discover");
  nonEmptyString(item.protocolVersion, `Agent Card.supportedInterfaces[${index}].protocolVersion`, "discover");
  if (item.tenant !== undefined) string(item.tenant, `Agent Card.supportedInterfaces[${index}].tenant`, "discover");
}

function validateSecurityScheme(name: string, value: unknown): void {
  const scheme = record(value, `securitySchemes.${name}`, "discover");
  const cases = [
    "apiKeySecurityScheme",
    "httpAuthSecurityScheme",
    "oauth2SecurityScheme",
    "openIdConnectSecurityScheme",
    "mtlsSecurityScheme",
  ].filter((key) => scheme[key] !== undefined);
  if (cases.length !== 1) {
    invalid(`Security scheme ${name} must contain exactly one scheme type`, "discover", "AGENT_CARD_INVALID");
  }
}

function validateSecurityRequirement(
  value: unknown,
  index: number,
  schemes: Readonly<Record<string, unknown>>,
): asserts value is SecurityRequirement {
  const requirement = record(value, `securityRequirements[${index}]`, "discover");
  const requirementSchemes = record(requirement.schemes, `securityRequirements[${index}].schemes`, "discover");
  Object.entries(requirementSchemes).forEach(([schemeName, scopes]) => {
    if (!(schemeName in schemes)) {
      invalid(`Security requirement references unknown scheme ${schemeName}`, "discover", "AGENT_CARD_INVALID");
    }
    const list = record(scopes, `securityRequirements[${index}].schemes.${schemeName}`, "discover");
    stringArray(list.list, `securityRequirements[${index}].schemes.${schemeName}.list`, "discover");
  });
}

function validateMessage(
  value: unknown,
  operation: OperationName,
  path: string,
  requiredRole?: "ROLE_USER" | "ROLE_AGENT",
): Message {
  validateSchema("Message", value, operation, operation === "discover" ? "AGENT_CARD_INVALID" : "PROTOCOL_VIOLATION");
  const message = record(value, path, operation);
  nonEmptyString(message.messageId, `${path}.messageId`, operation);
  if (message.role !== "ROLE_USER" && message.role !== "ROLE_AGENT") {
    invalid(`${path}.role must be ROLE_USER or ROLE_AGENT`, operation);
  }
  if (requiredRole && message.role !== requiredRole) {
    invalid(`${path}.role must be ${requiredRole}`, operation);
  }
  const parts = array(message.parts, `${path}.parts`, operation);
  if (parts.length === 0) invalid(`${path}.parts must contain at least one Part`, operation);
  parts.forEach((part, index) => validatePart(part, operation, `${path}.parts[${index}]`));
  if (message.contextId !== undefined) string(message.contextId, `${path}.contextId`, operation);
  if (message.taskId !== undefined) string(message.taskId, `${path}.taskId`, operation);
  return structuredClone(value) as Message;
}

function validatePart(value: unknown, operation: OperationName, path: string): asserts value is Part {
  const part = record(value, path, operation);
  const cases = ["text", "raw", "url", "data"].filter((key) => part[key] !== undefined);
  if (cases.length !== 1) invalid(`${path} must contain exactly one content representation`, operation);
  if (cases[0] === "text" || cases[0] === "raw" || cases[0] === "url") {
    string(part[cases[0]], `${path}.${cases[0]}`, operation);
  }
}

function validateTaskStatus(value: unknown, operation: OperationName, path: string): TaskStatus {
  const status = record(value, path, operation);
  nonEmptyString(status.state, `${path}.state`, operation);
  if (status.message !== undefined) validateMessage(status.message, operation, `${path}.message`);
  if (status.timestamp !== undefined) {
    const timestamp = string(status.timestamp, `${path}.timestamp`, operation);
    if (!isA2aTimestamp(timestamp)) {
      invalid(`${path}.timestamp must be an ISO 8601 UTC timestamp ending in Z`, operation);
    }
  }
  return structuredClone(value) as TaskStatus;
}

function validateArtifact(value: unknown, operation: OperationName, path: string): Artifact {
  const artifact = record(value, path, operation);
  nonEmptyString(artifact.artifactId, `${path}.artifactId`, operation);
  const parts = array(artifact.parts, `${path}.parts`, operation);
  if (parts.length === 0) invalid(`${path}.parts must contain at least one Part`, operation);
  parts.forEach((part, index) => validatePart(part, operation, `${path}.parts[${index}]`));
  return structuredClone(value) as Artifact;
}

function validateStatusUpdate(value: unknown, operation: OperationName): TaskStatusUpdateEvent {
  const update = record(value, "StreamResponse.statusUpdate", operation);
  nonEmptyString(update.taskId, "StreamResponse.statusUpdate.taskId", operation);
  nonEmptyString(update.contextId, "StreamResponse.statusUpdate.contextId", operation);
  validateTaskStatus(update.status, operation, "StreamResponse.statusUpdate.status");
  return structuredClone(value) as TaskStatusUpdateEvent;
}

function validateArtifactUpdate(value: unknown, operation: OperationName): TaskArtifactUpdateEvent {
  const update = record(value, "StreamResponse.artifactUpdate", operation);
  nonEmptyString(update.taskId, "StreamResponse.artifactUpdate.taskId", operation);
  nonEmptyString(update.contextId, "StreamResponse.artifactUpdate.contextId", operation);
  validateArtifact(update.artifact, operation, "StreamResponse.artifactUpdate.artifact");
  return structuredClone(value) as TaskArtifactUpdateEvent;
}

function validateSchema(
  definition: string,
  value: unknown,
  operation: OperationName,
  code: "AGENT_CARD_INVALID" | "PROTOCOL_VIOLATION" | "STREAM_INVALID",
): void {
  const validator = getSchemaValidator(definition);
  if (!validator(value)) {
    invalid(`${definition} failed schema validation: ${formatAjvErrors(validator.errors)}`, operation, code);
  }
}

function getSchemaValidator(definition: string): ValidateFunction {
  const cached = schemaValidators.get(definition);
  if (cached) return cached;
  const validator = ajv.compile({
    ...schemaBundle,
    $ref: `#/definitions/${definition}`,
  });
  schemaValidators.set(definition, validator);
  return validator;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 4)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function relaxUnknownFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relaxUnknownFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "additionalProperties" && nested === false ? true : relaxUnknownFields(nested),
    ]),
  );
}

function record(value: unknown, path: string, operation: OperationName): JsonRecord {
  if (!isRecord(value)) invalid(`${path} must be an object`, operation);
  return value;
}

function optionalRecord(value: unknown, path: string, operation: OperationName): JsonRecord | undefined {
  return value === undefined ? undefined : record(value, path, operation);
}

function array(value: unknown, path: string, operation: OperationName): unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`, operation);
  return value;
}

function optionalArray(value: unknown, path: string, operation: OperationName): unknown[] | undefined {
  return value === undefined ? undefined : array(value, path, operation);
}

function string(value: unknown, path: string, operation: OperationName): string {
  if (typeof value !== "string") invalid(`${path} must be a string`, operation);
  return value;
}

function nonEmptyString(value: unknown, path: string, operation: OperationName): string {
  const result = string(value, path, operation);
  if (!result.trim()) invalid(`${path} must not be empty`, operation);
  return result;
}

function stringArray(value: unknown, path: string, operation: OperationName): readonly string[] {
  return array(value, path, operation).map((item, index) => string(item, `${path}[${index}]`, operation));
}

function nonNegativeInteger(value: unknown, path: string, operation: OperationName): number {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(`${path} must be a non-negative integer`, operation);
  return value as number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSecurityScopeLists(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.securityRequirements)) return value;
  return {
    ...value,
    securityRequirements: value.securityRequirements.map((requirement) => {
      if (!isRecord(requirement) || !isRecord(requirement.schemes)) return requirement;
      return {
        ...requirement,
        schemes: Object.fromEntries(
          Object.entries(requirement.schemes).map(([name, scopes]) => [
            name,
            isRecord(scopes) && scopes.list === undefined ? { ...scopes, list: [] } : scopes,
          ]),
        ),
      };
    }),
  };
}

function isA2aTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function invalid(
  message: string,
  operation: OperationName,
  code?: "AGENT_CARD_INVALID" | "PROTOCOL_VIOLATION" | "STREAM_INVALID",
): never {
  const resolvedCode = code ?? (operation === "discover" ? "AGENT_CARD_INVALID" : "PROTOCOL_VIOLATION");
  throw new A2aClientError(resolvedCode, message, { operation });
}
