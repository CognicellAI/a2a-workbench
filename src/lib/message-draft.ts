import type { WorkbenchPartInput, WorkbenchPartKind } from "@/lib/workbench-types";

export type MessagePartDraft = {
  readonly id: string;
  readonly kind: WorkbenchPartKind;
  readonly value: string;
  readonly mediaType: string;
  readonly filename: string;
  readonly metadata: string;
};

export class MessageDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageDraftValidationError";
  }
}

export function createMessagePartDraft(id: string, kind: WorkbenchPartKind = "text"): MessagePartDraft {
  return { id, kind, value: "", mediaType: "", filename: "", metadata: "" };
}

export function toWorkbenchPartInputs(drafts: readonly MessagePartDraft[]): readonly WorkbenchPartInput[] {
  if (drafts.length === 0) {
    throw new MessageDraftValidationError("Add at least one message Part.");
  }
  return drafts.map((draft, index) => toWorkbenchPartInput(draft, index));
}

function toWorkbenchPartInput(draft: MessagePartDraft, index: number): WorkbenchPartInput {
  const value = draft.value.trim();
  if (!value) {
    throw new MessageDraftValidationError(`Part ${index + 1} requires a value.`);
  }

  const common = {
    ...(draft.mediaType.trim() ? { mediaType: draft.mediaType.trim() } : {}),
    ...(draft.filename.trim() ? { filename: draft.filename.trim() } : {}),
    ...(draft.metadata.trim() ? { metadata: parseJsonObject(draft.metadata, `Part ${index + 1} metadata`) } : {}),
  };

  switch (draft.kind) {
    case "text":
      return { kind: "text", text: value, ...common };
    case "raw":
      return { kind: "raw", raw: value, ...common };
    case "url":
      try {
        new URL(value);
      } catch {
        throw new MessageDraftValidationError(`Part ${index + 1} URL must be valid.`);
      }
      return { kind: "url", url: value, ...common };
    case "data":
      return { kind: "data", data: parseJson(value, `Part ${index + 1} data`), ...common };
    default: {
      const exhaustive: never = draft.kind;
      throw new MessageDraftValidationError(`Unsupported Part kind: ${exhaustive}`);
    }
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new MessageDraftValidationError(`${label} must be valid JSON.`);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!isRecord(parsed)) {
    throw new MessageDraftValidationError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
