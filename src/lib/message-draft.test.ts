import { describe, expect, it } from "vitest";
import {
  MessageDraftValidationError,
  createMessagePartDraft,
  toWorkbenchPartInputs,
  type MessagePartDraft,
} from "@/lib/message-draft";

describe("message drafts", () => {
  it("serializes all A2A v1 Part variants for the workbench command contract", () => {
    const parts: MessagePartDraft[] = [
      { ...createMessagePartDraft("text", "text"), value: "Describe the artifact." },
      { ...createMessagePartDraft("data", "data"), value: '{"priority":1}' },
      { ...createMessagePartDraft("raw", "raw"), value: "aGVsbG8=", mediaType: "text/plain" },
      { ...createMessagePartDraft("url", "url"), value: "https://example.com/artifact.pdf" },
    ];

    expect(toWorkbenchPartInputs(parts)).toEqual([
      { kind: "text", text: "Describe the artifact." },
      { kind: "data", data: { priority: 1 } },
      { kind: "raw", raw: "aGVsbG8=", mediaType: "text/plain" },
      { kind: "url", url: "https://example.com/artifact.pdf" },
    ]);
  });

  it("rejects malformed structured data before it reaches the BFF", () => {
    expect(() => toWorkbenchPartInputs([
      { ...createMessagePartDraft("data", "data"), value: "not-json" },
    ])).toThrow(MessageDraftValidationError);
  });
});
