import { describe, expect, it } from "vitest";
import { mergeAssistantTranscriptText } from "@/lib/chat-transcript";

describe("assistant chat transcript merging", () => {
  it("folds word deltas into one readable response", () => {
    const first = mergeAssistantTranscriptText("", "Let");
    const second = mergeAssistantTranscriptText(first, "me");
    const third = mergeAssistantTranscriptText(second, "quickly");

    expect(third).toBe("Let me quickly");
  });

  it("attaches punctuation deltas without adding extra spaces", () => {
    const percent = mergeAssistantTranscriptText("2", "%");
    const phrase = mergeAssistantTranscriptText(percent, "gain");
    const sentence = mergeAssistantTranscriptText(phrase, ".");

    expect(sentence).toBe("2% gain.");
  });

  it("replaces short residual token trails with the complete final response", () => {
    const finalText = `Here's how Tesla (TSLA) performed today:

| Metric | Value |
|---|---|
| Daily Change | +2.13% |

Overall, a solid up day with a roughly 2% gain.`;

    expect(mergeAssistantTranscriptText("% gain .", finalText)).toBe(finalText);
  });

  it("replaces a streamed prefix with the richer consolidated answer", () => {
    const prefix = "Hello there";
    const finalText = `${prefix}

Here is the detailed follow-up.`;

    expect(mergeAssistantTranscriptText(prefix, finalText)).toBe(finalText);
  });

  it("ignores duplicate shorter text that already exists in the transcript", () => {
    const transcript = "Hello there. Here is the detailed follow-up.";

    expect(mergeAssistantTranscriptText(transcript, "Here is the detailed follow-up.")).toBe(transcript);
  });
});
