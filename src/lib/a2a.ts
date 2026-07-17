import {
  DEFAULT_SURFACE_ID,
  getA2uiClientCapabilities,
  isA2uiMimeType,
  normalizeA2uiPayload,
  stripFencedA2uiBlocks,
  extractFencedA2uiBlocks,
} from "@/lib/a2ui";
import type { A2aMeta, A2aStatus, WorkbenchError } from "@/lib/workbench-types";

type RecordValue = Record<string, unknown>;

export type BuildA2aRequestInput = {
  prompt: string;
  contextId?: string;
  a2uiTrigger: string;
};

export type BuiltA2aRequest = {
  id: string;
  messageId: string;
  body: RecordValue;
};

export function buildA2aStreamRequest({ prompt, contextId, a2uiTrigger }: BuildA2aRequestInput): BuiltA2aRequest {
  const id = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const text = withA2uiTrigger(prompt, a2uiTrigger);
  const trimmedContextId = contextId?.trim();
  const message: RecordValue = {
    messageId,
    role: "ROLE_USER",
    parts: [
      {
        text,
      },
    ],
  };

  if (trimmedContextId) {
    message.contextId = trimmedContextId;
  }

  const metadata: RecordValue = {
    a2uiClientCapabilities: getA2uiClientCapabilities(),
  };

  const body: RecordValue = {
    configuration: {
      acceptedOutputModes: ["text/plain"],
    },
    message,
    metadata,
  };

  return { id, messageId, body };
}

export function withA2uiTrigger(prompt: string, trigger: string): string {
  const trimmedPrompt = prompt.trim();
  const trimmedTrigger = trigger.trim();

  if (!trimmedTrigger || trimmedPrompt.includes(trimmedTrigger)) {
    return trimmedPrompt;
  }

  return `${trimmedPrompt}\n\n${trimmedTrigger}`;
}

export function extractA2aMeta(payload: unknown): A2aMeta | undefined {
  const candidates = getPayloadCandidates(payload);
  const meta: A2aMeta = {};

  candidates.forEach((candidate) => {
    const task = readRecord(candidate.task);
    const status = readRecord(candidate.status) ?? readRecord(task?.status);

    meta.id ??= isTaskRecord(candidate) ? undefined : readString(candidate.id);
    meta.taskId ??= readString(candidate.taskId) ?? readString(task?.id) ?? readTaskRecordId(candidate);
    meta.contextId ??= readString(candidate.contextId) ?? readString(readRecord(candidate.message)?.contextId) ?? readString(task?.contextId);
    meta.kind ??= readString(candidate.kind);
    meta.status ??= readString(status?.state);
    meta.final ??= readBoolean(candidate.final) ?? readBoolean(status?.final);
  });

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function extractA2aStatus(payload: unknown): A2aStatus | undefined {
  const candidates = getPayloadCandidates(payload);

  for (const candidate of candidates) {
    const status = readRecord(candidate.status) ?? readRecord(readRecord(candidate.task)?.status);
    const state = readString(status?.state) ?? readString(candidate.state) ?? readString(candidate.kind);

    if (!state) {
      continue;
    }

    return {
      state,
      final: readBoolean(candidate.final) ?? readBoolean(status?.final),
      message: extractStatusMessage(candidate),
    };
  }

  return undefined;
}

export function extractA2aError(payload: unknown): WorkbenchError | undefined {
  const candidates = getPayloadCandidates(payload);

  for (const candidate of candidates) {
    const error = readString(candidate.error) ?? readString(readRecord(candidate.error)?.message);
    if (error) {
      return { message: error };
    }
  }

  return undefined;
}

export function extractTextParts(payload: unknown): string[] {
  const textParts = getParts(payload).flatMap((part) => {
    const text = readString(readRecord(part)?.text) ?? readString(readRecord(part)?.data);
    if (!text) {
      return [];
    }

    const stripped = stripFencedA2uiBlocks(text);
    return stripped ? [stripped] : [];
  });

  return [...new Set(textParts)];
}

export function extractA2uiEnvelopes(payload: unknown): unknown[] {
  const fromParts = getParts(payload).flatMap((part) => {
    const record = readRecord(part);
    if (!record) {
      return [];
    }

    const data = extractA2uiDataFromPart(record);
    if (data !== undefined) {
      return normalizeA2uiPayload(data);
    }

    const text = readString(record.text);
    if (text) {
      return extractFencedA2uiBlocks(text).flatMap(normalizeA2uiPayload);
    }

    return [];
  });

  if (fromParts.length > 0) {
    return fromParts;
  }

  return getPayloadCandidates(payload).flatMap((candidate) => normalizeA2uiPayload(candidate));
}

export function extractNegotiatedA2uiEnvelopes(payload: unknown): unknown[] {
  return getParts(payload).flatMap((part) => {
    const record = readRecord(part);
    if (!record) {
      return [];
    }
    const data = extractA2uiDataFromPart(record);
    return data === undefined ? [] : normalizeA2uiPayload(data);
  });
}

function extractA2uiDataFromPart(part: RecordValue): unknown | undefined {
  const metadata = readRecord(part.metadata);
  if (isA2uiMimeType(part.mediaType) || isA2uiMimeType(part.mimeType) ||
    isA2uiMimeType(metadata?.mediaType) || isA2uiMimeType(metadata?.mimeType)) {
    return part.data ?? part;
  }

  const data = readRecord(part.data);
  const dataMetadata = readRecord(data?.metadata);
  if (data && (isA2uiMimeType(data.mediaType) || isA2uiMimeType(data.mimeType) ||
    isA2uiMimeType(dataMetadata?.mediaType) || isA2uiMimeType(dataMetadata?.mimeType))) {
    return data.data ?? data.value ?? data;
  }

  return undefined;
}

function getParts(payload: unknown): unknown[] {
  return getPayloadCandidates(payload).flatMap((candidate) => [
    ...readArray(candidate.parts),
    ...readArray(readRecord(candidate.payload)?.parts),
    ...readArray(readRecord(readRecord(candidate.status)?.message)?.parts),
    ...readArray(readRecord(candidate.message)?.parts),
    ...readArray(readRecord(candidate.artifact)?.parts),
    ...readArray(candidate.artifacts).flatMap((artifact) => readArray(readRecord(artifact)?.parts)),
  ]);
}

function getPayloadCandidates(payload: unknown): RecordValue[] {
  const root = readRecord(payload);
  if (!root) {
    return [];
  }

  const candidates: RecordValue[] = [root];
  const result = readRecord(root.result);
  const params = readRecord(root.params);
  const paramsResult = readRecord(params?.result);
  const statusUpdate = readRecord(root.statusUpdate) ?? readRecord(result?.statusUpdate);
  const artifactUpdate = readRecord(root.artifactUpdate) ?? readRecord(result?.artifactUpdate);
  const task = readRecord(root.task) ?? readRecord(result?.task) ?? readRecord(paramsResult?.task);

  [result, params, paramsResult, statusUpdate, artifactUpdate, task].forEach((candidate) => {
    if (candidate) {
      candidates.push(candidate);
    }
  });

  return uniqueRecords(candidates);
}

function extractStatusMessage(candidate: RecordValue): string | undefined {
  const direct = readString(candidate.message);
  if (direct) {
    return direct;
  }

  const task = readRecord(candidate.task);
  const status = readRecord(candidate.status) ?? readRecord(task?.status);
  const errorMessage = readString(readRecord(candidate.error)?.message) ?? readString(readRecord(status?.error)?.message);
  if (errorMessage) {
    return errorMessage;
  }

  const statusMessage = readRecord(status?.message);
  const text = statusMessage?.parts ? extractTextParts(statusMessage).join("\n") : undefined;
  return text || undefined;
}

function isTaskRecord(value: RecordValue): boolean {
  return Boolean(readString(value.id) && readString(value.contextId) && readRecord(value.status));
}

function readTaskRecordId(value: RecordValue): string | undefined {
  return isTaskRecord(value) ? readString(value.id) : undefined;
}

function uniqueRecords(values: RecordValue[]): RecordValue[] {
  return [...new Set(values)];
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function emptyA2uiSurfaceMessage(): unknown[] {
  return normalizeA2uiPayload({
    messages: [
      {
        version: "v0.9",
        createSurface: {
          surfaceId: DEFAULT_SURFACE_ID,
        },
      },
    ],
  });
}
