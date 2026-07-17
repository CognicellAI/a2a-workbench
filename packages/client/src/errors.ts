import type { OperationName } from "./types.js";

export const A2A_CLIENT_ERROR_CODES = [
  "DISCOVERY_FAILED",
  "AGENT_CARD_INVALID",
  "CACHE_REVALIDATION_FAILED",
  "UNSUPPORTED_TRANSPORT",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_EXTENSION",
  "SIGNATURE_VERIFICATION_FAILED",
  "UNSUPPORTED_AUTHENTICATION",
  "AUTHENTICATION_FAILED",
  "VERSION_NOT_SUPPORTED",
  "PROTOCOL_VIOLATION",
  "RESPONSE_ID_MISMATCH",
  "STREAM_INVALID",
  "TASK_NOT_FOUND",
  "TASK_NOT_CANCELABLE",
  "REMOTE_A2A_ERROR",
  "URL_POLICY_REJECTED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "ABORTED",
] as const;

export type A2aClientErrorCode = (typeof A2A_CLIENT_ERROR_CODES)[number];

export type A2aClientErrorOptions = {
  readonly operation: OperationName;
  readonly retryable?: boolean;
  readonly httpStatus?: number;
  readonly protocolCode?: string | number;
  readonly details?: unknown;
  readonly cause?: unknown;
};

export class A2aClientError extends Error {
  readonly code: A2aClientErrorCode;
  readonly operation: OperationName;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly protocolCode?: string | number;
  readonly details?: unknown;

  constructor(code: A2aClientErrorCode, message: string, options: A2aClientErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "A2aClientError";
    this.code = code;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.protocolCode = options.protocolCode;
    this.details = options.details;
  }
}

export function asA2aClientError(error: unknown, operation: OperationName): A2aClientError {
  if (error instanceof A2aClientError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new A2aClientError("ABORTED", `${operation} was aborted`, { operation, cause: error });
  }
  const message = error instanceof Error ? error.message : "Unknown A2A client failure";
  return new A2aClientError("NETWORK_ERROR", `${operation} failed: ${message}`, {
    operation,
    retryable: true,
    cause: error,
  });
}
