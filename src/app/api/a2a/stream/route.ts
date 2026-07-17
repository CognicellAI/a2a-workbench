import { encodeSseEvent } from "@/lib/sse";
import {
  runWorkbenchCommand,
  toWorkbenchError,
  type WorkbenchCommandBody,
} from "@/lib/workbench-client-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

export async function POST(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      try {
        const body = await readCommand(request);
        const ok = await runWorkbenchCommand(body, emit, request.signal);
        emit("done", { ok });
      } catch (error) {
        emit("error", toWorkbenchError(error));
        emit("done", { ok: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}

async function readCommand(request: Request): Promise<WorkbenchCommandBody> {
  const value: unknown = await request.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workbench request body must be a JSON object.");
  }
  return value as WorkbenchCommandBody;
}
