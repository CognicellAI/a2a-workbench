import type { SseFrame } from "@/lib/workbench-types";

export type ParsedSseBuffer = {
  frames: SseFrame[];
  remainder: string;
};

export function parseSseBuffer(input: string): ParsedSseBuffer {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const chunks = normalized.split("\n\n");
  const remainder = chunks.pop() ?? "";
  const frames = chunks.flatMap(parseSseFrame);

  return { frames, remainder };
}

export function parseSseFrame(frame: string): SseFrame[] {
  const lines = frame.split("\n");
  const data: string[] = [];
  const parsed: SseFrame = { data: "" };

  lines.forEach((line) => {
    if (!line || line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    switch (field) {
      case "event":
        parsed.event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        parsed.id = value;
        break;
      case "retry": {
        const retry = Number(value);
        if (Number.isFinite(retry)) {
          parsed.retry = retry;
        }
        break;
      }
      default:
        break;
    }
  });

  if (data.length === 0) {
    return [];
  }

  return [{ ...parsed, data: data.join("\n") }];
}

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
