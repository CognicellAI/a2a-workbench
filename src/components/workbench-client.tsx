"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  KeyRound,
  Link2,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  A2uiSurface,
  MarkdownContext,
  basicCatalog,
  type ReactComponentImplementation,
} from "@a2ui/react/v0_9";
import { injectStyles, removeStyles } from "@a2ui/react/styles";
import { MessageProcessor, type A2uiMessage, type SurfaceModel } from "@a2ui/web_core/v0_9";
import { mergeAssistantTranscriptText } from "@/lib/chat-transcript";
import { DEFAULT_A2UI_TRIGGER, toPersistableConnection } from "@/lib/connection";
import { parseSseBuffer } from "@/lib/sse";
import type {
  A2aMeta,
  A2aStatus,
  ChatMessage,
  PersistedConnection,
  PersistedHeader,
  PersistedM2mOAuth,
  SseFrame,
  WorkbenchError,
  WorkbenchEventType,
} from "@/lib/workbench-types";

type HeaderRow = PersistedHeader & { id: string };
type RunState = "idle" | "streaming" | "complete" | "failed" | "aborted";
type InspectorTab = "run" | "request" | "raw" | "a2a" | "a2ui" | "meta";

type TimelineEntry = {
  id: string;
  type: string;
  time: string;
  summary: string;
};

type ClientActionEntry = {
  id: string;
  time: string;
  action: unknown;
};

const CONNECTION_STORAGE_KEY = "a2a-workbench.connection";
const SPLIT_STORAGE_KEY = "a2a-workbench.split";
const INSPECTOR_SPLIT_STORAGE_KEY = "a2a-workbench.inspectorSplit";
const CONNECTION_PANEL_STORAGE_KEY = "a2a-workbench.connectionPanelOpen";
const DEFAULT_SPLIT = 44;
const MIN_SPLIT = 30;
const MAX_SPLIT = 70;
const DEFAULT_INSPECTOR_SPLIT = 72;
const MIN_INSPECTOR_SPLIT = 56;
const MAX_INSPECTOR_SPLIT = 84;
const chatMarkdownPlugins = [remarkGfm];
const chatMarkdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 text-sm leading-6 text-ink last:mb-0">{children}</p>,
  a: ({ href, children }) => {
    if (!href) {
      return <span className="font-semibold text-cyan-strong">{children}</span>;
    }

    const external = isExternalHref(href);
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        className="font-semibold text-cyan-strong underline decoration-cyan/35 underline-offset-4 transition hover:text-white"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-cyan/45 bg-cyan/5 py-2 pl-3 text-sm leading-6 text-muted">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => (
    <code className={`rounded border border-white/10 bg-graphite-950/80 px-1.5 py-0.5 font-mono text-[0.84em] text-cyan-strong ${className ?? ""}`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 max-h-80 overflow-auto rounded-lg border border-white/10 bg-graphite-950/85 p-3 font-mono text-[11px] leading-5 text-muted">
      {children}
    </pre>
  ),
  h1: ({ children }) => <h1 className="mb-3 mt-1 text-base font-black text-white">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-3 text-[15px] font-black text-white">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-black text-white">{children}</h3>,
  hr: () => <hr className="my-4 border-white/10" />,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-6 text-ink">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-ink">{children}</ol>,
  li: ({ children }) => <li className="pl-1 marker:text-cyan">{children}</li>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-max border-collapse text-left text-xs text-ink">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.06] text-white">{children}</thead>,
  th: ({ children }) => <th className="border-b border-white/10 px-3 py-2 font-black">{children}</th>,
  td: ({ children }) => <td className="border-t border-white/10 px-3 py-2 align-top text-muted">{children}</td>,
  img: ({ src, alt }) => {
    const imageHref = typeof src === "string" ? src : undefined;
    if (!imageHref) {
      return <span className="text-muted">{alt || "Image"}</span>;
    }

    return (
      <a
        href={imageHref}
        target="_blank"
        rel="noreferrer"
        className="font-semibold text-cyan-strong underline decoration-cyan/35 underline-offset-4"
      >
        {alt ? `Image: ${alt}` : "Image attachment"}
      </a>
    );
  },
};
const FAILED_STATES = new Set([
  "failed",
  "error",
  "rejected",
  "canceled",
  "cancelled",
  "task_state_failed",
  "task_state_rejected",
  "task_state_canceled",
  "task_state_cancelled",
]);
const defaultM2mOAuth: PersistedM2mOAuth = {
  enabled: false,
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  audience: "",
  authMethod: "client_secret_basic",
};

const defaultHeaders: HeaderRow[] = [
  {
    id: "header-apikey",
    name: "apikey",
    value: "",
    enabled: false,
    secret: true,
  },
];

export function WorkbenchClient() {
  const [upstream, setUpstream] = useState("");
  const [a2uiTrigger, setA2uiTrigger] = useState(DEFAULT_A2UI_TRIGGER);
  const [headers, setHeaders] = useState<HeaderRow[]>(defaultHeaders);
  const [oauth, setOauth] = useState<PersistedM2mOAuth>(defaultM2mOAuth);
  const [contextId, setContextId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [status, setStatus] = useState<A2aStatus | undefined>();
  const [meta, setMeta] = useState<A2aMeta>({});
  const [requestInfo, setRequestInfo] = useState<unknown>();
  const [rawFrames, setRawFrames] = useState<unknown[]>([]);
  const [a2aFrames, setA2aFrames] = useState<unknown[]>([]);
  const [a2uiEvents, setA2uiEvents] = useState<unknown[]>([]);
  const [errors, setErrors] = useState<WorkbenchError[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [activeTab, setActiveTab] = useState<InspectorTab>("run");
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [inspectorSplit, setInspectorSplit] = useState(DEFAULT_INSPECTOR_SPLIT);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [surfaces, setSurfaces] = useState<SurfaceModel<ReactComponentImplementation>[]>([]);
  const [clientActions, setClientActions] = useState<ClientActionEntry[]>([]);
  const failedStatusRef = useRef(false);
  const assistantMessageIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef("");

  const processor = useMemo(
    () =>
      new MessageProcessor<ReactComponentImplementation>([basicCatalog], (action) => {
        setClientActions((current) =>
          limitList(
            [
              ...current,
              {
                id: newId(),
                time: formatTime(new Date()),
                action,
              },
            ],
            50,
          ),
        );
      }),
    [],
  );

  const syncSurfaces = useCallback(() => {
    setSurfaces([...processor.model.surfacesMap.values()]);
  }, [processor]);

  const clearSurfaces = useCallback(() => {
    [...processor.model.surfacesMap.keys()].forEach((surfaceId) => {
      processor.model.deleteSurface(surfaceId);
    });
    syncSurfaces();
  }, [processor, syncSurfaces]);

  const addTimeline = useCallback((type: string, data: unknown) => {
    setTimeline((current) =>
      limitList(
        [
          ...current,
          {
            id: newId(),
            type,
            time: formatTime(new Date()),
            summary: summarizeEvent(data),
          },
        ],
        160,
      ),
    );
  }, []);

  const addError = useCallback((error: WorkbenchError) => {
    setErrors((current) => limitList([...current, error], 80));
  }, []);

  const resetAssistantTranscript = useCallback(() => {
    assistantMessageIdRef.current = null;
    assistantTextRef.current = "";
  }, []);

  const upsertAssistantTranscript = useCallback((text: string) => {
    setChat((current) => {
      const messageId = assistantMessageIdRef.current ?? newId();
      const mergedText = mergeAssistantTranscriptText(assistantTextRef.current, text);
      assistantMessageIdRef.current = messageId;
      assistantTextRef.current = mergedText;

      const existingIndex = current.findIndex((message) => message.id === messageId);
      if (existingIndex === -1) {
        return limitList([...current, { id: messageId, role: "assistant", text: mergedText }], 140);
      }

      return current.map((message) => (message.id === messageId ? { ...message, text: mergedText } : message));
    });
  }, []);

  const processA2uiMessages = useCallback(
    (messages: unknown[]) => {
      try {
        getCreateSurfaceIds(messages).forEach((surfaceId) => {
          if (processor.model.getSurface(surfaceId)) {
            processor.model.deleteSurface(surfaceId);
          }
        });

        processor.processMessages(messages as A2uiMessage[]);
        syncSurfaces();
      } catch (error) {
        addError({ message: "A2UI renderer error.", detail: error instanceof Error ? error.message : error });
      }
    },
    [addError, processor, syncSurfaces],
  );

  const handleWorkbenchFrame = useCallback(
    (frame: SseFrame) => {
      const type = frame.event as WorkbenchEventType | undefined;
      if (!type) {
        return;
      }

      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        addError({ message: "Workbench stream event was not valid JSON.", detail: frame.data });
        return;
      }

      addTimeline(type, data);

      switch (type) {
        case "request":
          setRequestInfo(data);
          break;
        case "raw":
          setRawFrames((current) => limitList([...current, data], 160));
          break;
        case "a2a":
          setA2aFrames((current) => limitList([...current, data], 160));
          break;
        case "meta": {
          const next = data as A2aMeta;
          setMeta((current) => ({ ...current, ...next }));
          if (next.contextId) {
            setContextId(next.contextId);
          }
          break;
        }
        case "status": {
          const next = data as A2aStatus;
          setStatus(next);
          if (FAILED_STATES.has(next.state.toLowerCase())) {
            failedStatusRef.current = true;
            setRunState("failed");
            if (next.message) {
              addError({ message: next.message, detail: next });
            }
          }
          break;
        }
        case "text": {
          const text = readEventText(data);
          if (text) {
            upsertAssistantTranscript(text);
            if (failedStatusRef.current) {
              addError({ message: text });
            }
          }
          break;
        }
        case "a2ui": {
          const messages = readA2uiMessages(data);
          setA2uiEvents((current) => limitList([...current, data], 120));
          processA2uiMessages(messages);
          break;
        }
        case "error":
          addError(data as WorkbenchError);
          setChat((current) =>
            limitList(
              [
                ...current,
                {
                  id: newId(),
                  role: "system",
                  text: (data as WorkbenchError).message || "Stream error.",
                },
              ],
              140,
            ),
          );
          setRunState("failed");
          break;
        case "done": {
          const ok = Boolean((data as { ok?: boolean }).ok);
          setRunState((current) => {
            if (current === "aborted" || current === "failed" || failedStatusRef.current) {
              return current;
            }
            return ok ? "complete" : "failed";
          });
          break;
        }
        default:
          break;
      }
    },
    [addError, addTimeline, processA2uiMessages, upsertAssistantTranscript],
  );

  useEffect(() => {
    injectStyles();
    return () => {
      removeStyles();
    };
  }, []);

  useEffect(() => {
    const persisted = readPersistedConnection();
    if (persisted) {
      // LocalStorage hydration has to happen after mount because `window` is unavailable during SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUpstream(persisted.upstream);
      setA2uiTrigger(persisted.a2uiTrigger || DEFAULT_A2UI_TRIGGER);
      setHeaders(
        persisted.headers.length > 0
          ? persisted.headers.map((header) => ({ ...header, id: newId() }))
          : defaultHeaders,
      );
      setOauth(persisted.oauth);
    }

    const savedSplit = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY));
    if (Number.isFinite(savedSplit)) {
      setSplit(clamp(savedSplit, MIN_SPLIT, MAX_SPLIT));
    }

    const savedInspectorSplit = Number(window.localStorage.getItem(INSPECTOR_SPLIT_STORAGE_KEY));
    if (Number.isFinite(savedInspectorSplit)) {
      setInspectorSplit(clamp(savedInspectorSplit, MIN_INSPECTOR_SPLIT, MAX_INSPECTOR_SPLIT));
    }

    setConnectionOpen(window.localStorage.getItem(CONNECTION_PANEL_STORAGE_KEY) === "true");
  }, []);

  useEffect(() => {
    const persistable = toPersistableConnection({
      upstream,
      a2uiTrigger,
      headers: stripHeaderIds(headers),
      oauth,
    });
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(persistable));
  }, [a2uiTrigger, headers, oauth, upstream]);

  useEffect(() => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(split));
  }, [split]);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_SPLIT_STORAGE_KEY, String(inspectorSplit));
  }, [inspectorSplit]);

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_PANEL_STORAGE_KEY, String(connectionOpen));
  }, [connectionOpen]);

  useEffect(() => {
    return () => {
      abortController?.abort();
      processor.model.dispose();
    };
  }, [abortController, processor]);

  const sendPrompt = useCallback(async () => {
    const message = prompt.trim();
    if (!message || runState === "streaming") {
      return;
    }

    const controller = new AbortController();
    failedStatusRef.current = false;
    resetAssistantTranscript();
    setAbortController(controller);
    setRunState("streaming");
    setStatus({ state: "streaming" });
    setErrors([]);
    setPrompt("");
    setRawFrames([]);
    setA2aFrames([]);
    setA2uiEvents([]);
    setRequestInfo(undefined);
    setTimeline([]);

    if (!contextId.trim()) {
      clearSurfaces();
    }

    setChat((current) => limitList([...current, { id: newId(), role: "user", text: message }], 140));

    try {
      const response = await fetch("/api/a2a/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          contextId: contextId.trim() || undefined,
          connection: {
            upstream,
            a2uiTrigger,
            headers: stripHeaderIds(headers),
            oauth,
          },
        }),
        signal: controller.signal,
      });

      if (!response.body) {
        throw new Error(`Workbench route did not return a stream: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.remainder;
        parsed.frames.forEach(handleWorkbenchFrame);
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        parseSseBuffer(`${buffer}\n\n`).frames.forEach(handleWorkbenchFrame);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setRunState("aborted");
        setStatus({ state: "aborted" });
        setChat((current) =>
          limitList([...current, { id: newId(), role: "system", text: "Stream aborted by operator." }], 140),
        );
      } else {
        const messageText = error instanceof Error ? error.message : "Workbench request failed.";
        addError({ message: messageText });
        setRunState("failed");
        setStatus({ state: "failed", message: messageText });
      }
    } finally {
      setAbortController(null);
    }
  }, [
    a2uiTrigger,
    addError,
    clearSurfaces,
    contextId,
    handleWorkbenchFrame,
    headers,
    oauth,
    prompt,
    resetAssistantTranscript,
    runState,
    upstream,
  ]);

  const abortRun = useCallback(() => {
    abortController?.abort();
  }, [abortController]);

  const resetRun = useCallback(() => {
    abortController?.abort();
    failedStatusRef.current = false;
    resetAssistantTranscript();
    setRunState("idle");
    setStatus(undefined);
    setMeta({});
    setContextId("");
    setChat([]);
    setErrors([]);
    setTimeline([]);
    setRawFrames([]);
    setA2aFrames([]);
    setA2uiEvents([]);
    setRequestInfo(undefined);
    setClientActions([]);
    clearSurfaces();
  }, [abortController, clearSurfaces, resetAssistantTranscript]);

  const updateHeader = useCallback((id: string, patch: Partial<HeaderRow>) => {
    setHeaders((current) => current.map((header) => (header.id === id ? { ...header, ...patch } : header)));
  }, []);

  const removeHeader = useCallback((id: string) => {
    setHeaders((current) => current.filter((header) => header.id !== id));
  }, []);

  const addHeader = useCallback(() => {
    setHeaders((current) => [
      ...current,
      {
        id: newId(),
        name: "",
        value: "",
        enabled: true,
        secret: false,
      },
    ]);
  }, []);

  const runCounts = {
    raw: rawFrames.length,
    a2a: a2aFrames.length,
    a2ui: a2uiEvents.length,
    errors: errors.length,
  };

  return (
    <main className="flex h-[100dvh] min-h-0 flex-col gap-2 overflow-hidden p-2 text-ink">
      <TopBar runState={runState} status={status} contextId={contextId} counts={runCounts} />
      <ConnectionPanel
        upstream={upstream}
        a2uiTrigger={a2uiTrigger}
        headers={headers}
        oauth={oauth}
        contextId={contextId}
        open={connectionOpen}
        onUpstreamChange={setUpstream}
        onTriggerChange={setA2uiTrigger}
        onContextChange={setContextId}
        onHeaderChange={updateHeader}
        onHeaderRemove={removeHeader}
        onHeaderAdd={addHeader}
        onOAuthChange={(patch) => setOauth((current) => ({ ...current, ...patch }))}
        onOpenChange={setConnectionOpen}
      />
      <ResizableColumns
        split={inspectorSplit}
        minSplit={MIN_INSPECTOR_SPLIT}
        maxSplit={MAX_INSPECTOR_SPLIT}
        onSplitChange={setInspectorSplit}
        label="Resize A2UI and protocol inspector panes"
        className="workbench-panel min-h-0 flex-1"
      >
        <ResizableColumns
          split={split}
          minSplit={MIN_SPLIT}
          maxSplit={MAX_SPLIT}
          onSplitChange={setSplit}
          label="Resize chat and A2UI panes"
          className="h-full min-h-0"
        >
          <ChatPane
            chat={chat}
            prompt={prompt}
            runState={runState}
            onPromptChange={setPrompt}
            onSend={sendPrompt}
            onAbort={abortRun}
            onReset={resetRun}
          />
          <A2uiStage surfaces={surfaces} />
        </ResizableColumns>
        <ProtocolInspector
          activeTab={activeTab}
          onTabChange={setActiveTab}
          timeline={timeline}
          errors={errors}
          requestInfo={requestInfo}
          rawFrames={rawFrames}
          a2aFrames={a2aFrames}
          a2uiEvents={a2uiEvents}
          meta={meta}
          status={status}
          clientActions={clientActions}
          counts={runCounts}
        />
      </ResizableColumns>
    </main>
  );
}

function TopBar({
  runState,
  status,
  contextId,
  counts,
}: {
  runState: RunState;
  status?: A2aStatus;
  contextId: string;
  counts: { raw: number; a2a: number; a2ui: number; errors: number };
}) {
  return (
    <header className="workbench-panel flex min-h-14 items-center justify-between gap-4 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan/40 bg-cyan/10 text-cyan-strong shadow-[0_0_28px_rgb(17_240_240/0.18)]"
          aria-hidden="true"
        >
          <Link2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-black tracking-normal text-white">A2A + A2UI Workbench</p>
          <p className="truncate text-xs font-medium text-muted">
            Real message:send and message:stream traffic with protocol evidence and rendered A2UI surfaces
          </p>
        </div>
      </div>
      <div className="hidden items-center gap-2 lg:flex">
        <StatusBadge runState={runState} status={status} />
        <Metric label="Raw" value={counts.raw} />
        <Metric label="A2A" value={counts.a2a} />
        <Metric label="A2UI" value={counts.a2ui} />
        <Metric label="Errors" value={counts.errors} tone={counts.errors > 0 ? "alert" : "normal"} />
        <div className="max-w-64 truncate rounded-lg border border-white/10 bg-graphite-950/70 px-3 py-2 font-mono text-[11px] text-muted">
          {contextId || "No context"}
        </div>
      </div>
    </header>
  );
}

function StatusBadge({ runState, status }: { runState: RunState; status?: A2aStatus }) {
  const tone =
    runState === "streaming"
      ? "border-cyan/45 bg-cyan/10 text-cyan-strong"
      : runState === "failed" || runState === "aborted"
        ? "border-violet/45 bg-violet/10 text-white"
        : "border-white/12 bg-white/[0.055] text-muted";

  return (
    <div className={`inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-xs font-black ${tone}`}>
      <Activity className="h-4 w-4" aria-hidden="true" />
      <span className="capitalize">{status?.state ?? runState}</span>
    </div>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: number; tone?: "normal" | "alert" }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.045] px-3 py-1.5">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className={`font-mono text-sm font-black ${tone === "alert" ? "text-violet" : "text-cyan-strong"}`}>{value}</p>
    </div>
  );
}

function ConnectionPanel({
  upstream,
  a2uiTrigger,
  headers,
  oauth,
  contextId,
  open,
  onUpstreamChange,
  onTriggerChange,
  onContextChange,
  onHeaderChange,
  onHeaderRemove,
  onHeaderAdd,
  onOAuthChange,
  onOpenChange,
}: {
  upstream: string;
  a2uiTrigger: string;
  headers: HeaderRow[];
  oauth: PersistedM2mOAuth;
  contextId: string;
  open: boolean;
  onUpstreamChange: (value: string) => void;
  onTriggerChange: (value: string) => void;
  onContextChange: (value: string) => void;
  onHeaderChange: (id: string, patch: Partial<HeaderRow>) => void;
  onHeaderRemove: (id: string) => void;
  onHeaderAdd: () => void;
  onOAuthChange: (patch: Partial<PersistedM2mOAuth>) => void;
  onOpenChange: (value: boolean) => void;
}) {
  const enabledHeaderCount = headers.filter((header) => header.enabled && header.name.trim()).length;

  return (
    <section className="workbench-panel grid gap-2 p-2">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted">
          <span className="flex items-center gap-2 font-black text-white">
            <SlidersHorizontal className="h-3.5 w-3.5 text-cyan" aria-hidden="true" />
            Connection
          </span>
          <span className="max-w-[52ch] truncate rounded-lg border border-white/10 bg-graphite-950/60 px-2 py-1 font-mono text-[11px]">
            {upstream || "No upstream"}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1">
            {oauth.enabled ? "OAuth on" : "OAuth off"}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1">
            {enabledHeaderCount} headers
          </span>
          {contextId ? (
            <span className="max-w-[38ch] truncate rounded-lg border border-white/10 bg-graphite-950/60 px-2 py-1 font-mono text-[11px]">
              {contextId}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn-secondary min-h-8 px-2 py-1 text-xs"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          {open ? "Collapse" : "Edit"}
        </button>
      </div>

      {open ? (
        <div className="grid gap-2 border-t border-white/10 pt-2 xl:grid-cols-[minmax(320px,0.92fr)_minmax(430px,1.18fr)_minmax(330px,0.9fr)]">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_132px] xl:grid-cols-[minmax(0,1fr)_96px]">
            <label className="grid gap-1.5">
              <span className="flex items-center gap-2 text-xs font-black text-muted">
                <Link2 className="h-3.5 w-3.5 text-cyan" aria-hidden="true" />
                A2A upstream
              </span>
              <input
                className="workbench-input workbench-input-compact"
                placeholder="https://agent.example.com/a2a"
                value={upstream}
                onChange={(event) => onUpstreamChange(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-black text-muted">A2UI trigger</span>
              <input
                className="workbench-input workbench-input-compact"
                value={a2uiTrigger}
                onChange={(event) => onTriggerChange(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 md:col-span-2 xl:col-span-2">
              <span className="text-xs font-black text-muted">Context ID</span>
              <input
                className="workbench-input workbench-input-compact font-mono text-xs"
                placeholder="Returned by upstream"
                value={contextId}
                onChange={(event) => onContextChange(event.target.value)}
              />
            </label>
          </div>
          <OAuthPanel oauth={oauth} onOAuthChange={onOAuthChange} />
          <div className="grid min-h-0 gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-xs font-black text-muted">
                <KeyRound className="h-3.5 w-3.5 text-cyan" aria-hidden="true" />
                Per-run headers
              </p>
              <button type="button" className="btn-secondary min-h-8 px-2 py-1 text-xs" onClick={onHeaderAdd}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </button>
            </div>
            <div className="grid max-h-[5.5rem] gap-1.5 overflow-auto pr-1">
              {headers.map((header) => (
                <div key={header.id} className="grid gap-1.5 md:grid-cols-[74px_minmax(0,1fr)_minmax(0,1fr)_70px_32px]">
                  <label className="flex min-h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-graphite-950/60 px-2 text-xs font-bold text-muted">
                    <input
                      type="checkbox"
                      aria-label={`Send header ${header.name || "row"}`}
                      checked={header.enabled}
                      onChange={(event) => onHeaderChange(header.id, { enabled: event.target.checked })}
                    />
                    Send
                  </label>
                  <input
                    className="workbench-input workbench-input-compact text-xs"
                    placeholder="Header"
                    value={header.name}
                    onChange={(event) => onHeaderChange(header.id, { name: event.target.value })}
                  />
                  <input
                    className="workbench-input workbench-input-compact text-xs"
                    placeholder={header.secret ? "Not persisted" : "Value"}
                    type={header.secret ? "password" : "text"}
                    value={header.value}
                    onChange={(event) => onHeaderChange(header.id, { value: event.target.value })}
                  />
                  <label className="flex min-h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-graphite-950/60 px-2 text-xs font-bold text-muted">
                    <input
                      type="checkbox"
                      aria-label={`Treat header ${header.name || "row"} as secret`}
                      checked={header.secret}
                      onChange={(event) => onHeaderChange(header.id, { secret: event.target.checked })}
                    />
                    Secret
                  </label>
                  <button
                    type="button"
                    className="btn-secondary min-h-8 px-2"
                    aria-label="Remove header"
                    title="Remove header"
                    onClick={() => onHeaderRemove(header.id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function OAuthPanel({
  oauth,
  onOAuthChange,
}: {
  oauth: PersistedM2mOAuth;
  onOAuthChange: (patch: Partial<PersistedM2mOAuth>) => void;
}) {
  const disabledClass = oauth.enabled ? "" : "opacity-55";

  return (
    <div className="grid min-h-0 gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-black text-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-cyan" aria-hidden="true" />
          M2M OAuth
        </p>
        <label className="flex min-h-8 items-center gap-2 rounded-lg border border-white/10 bg-graphite-950/60 px-3 text-xs font-bold text-muted">
          <input
            type="checkbox"
            aria-label="Enable M2M OAuth"
            checked={oauth.enabled}
            onChange={(event) => onOAuthChange({ enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
      <div className={`grid gap-2 ${disabledClass}`}>
        <label className="grid gap-1.5">
          <span className="text-xs font-black text-muted">Token URL</span>
          <input
            className="workbench-input workbench-input-compact text-xs"
            aria-label="Token URL"
            placeholder="https://issuer.example.com/oauth/token"
            value={oauth.tokenUrl}
            disabled={!oauth.enabled}
            onChange={(event) => onOAuthChange({ tokenUrl: event.target.value })}
          />
        </label>
        <div className="grid gap-2 md:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-xs font-black text-muted">Client ID</span>
            <input
              className="workbench-input workbench-input-compact text-xs"
              aria-label="Client ID"
              value={oauth.clientId}
              disabled={!oauth.enabled}
              onChange={(event) => onOAuthChange({ clientId: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-black text-muted">Client secret</span>
            <input
              className="workbench-input workbench-input-compact text-xs"
              aria-label="Client secret"
              type="password"
              placeholder="Not persisted"
              value={oauth.clientSecret}
              disabled={!oauth.enabled}
              onChange={(event) => onOAuthChange({ clientSecret: event.target.value })}
            />
          </label>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_154px]">
          <label className="grid gap-1.5">
            <span className="text-xs font-black text-muted">Scope</span>
            <input
              className="workbench-input workbench-input-compact text-xs"
              aria-label="Scope"
              placeholder="Optional"
              value={oauth.scope}
              disabled={!oauth.enabled}
              onChange={(event) => onOAuthChange({ scope: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-black text-muted">Audience</span>
            <input
              className="workbench-input workbench-input-compact text-xs"
              aria-label="Audience"
              placeholder="Optional"
              value={oauth.audience}
              disabled={!oauth.enabled}
              onChange={(event) => onOAuthChange({ audience: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-black text-muted">Auth method</span>
            <select
              className="workbench-input workbench-input-compact text-xs"
              aria-label="Auth method"
              value={oauth.authMethod}
              disabled={!oauth.enabled}
              onChange={(event) =>
                onOAuthChange({ authMethod: event.target.value as PersistedM2mOAuth["authMethod"] })
              }
            >
              <option value="client_secret_basic">Basic</option>
              <option value="client_secret_post">Post body</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function ResizableColumns({
  split,
  minSplit,
  maxSplit,
  onSplitChange,
  label,
  className,
  children,
}: {
  split: number;
  minSplit: number;
  maxSplit: number;
  onSplitChange: (value: number) => void;
  label: string;
  className?: string;
  children: [ReactNode, ReactNode];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const splitStyle = { "--split": `${split}%` } as CSSProperties;

  const setFromPointer = useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        return;
      }
      const next = ((clientX - rect.left) / rect.width) * 100;
      onSplitChange(clamp(next, minSplit, maxSplit));
    },
    [maxSplit, minSplit, onSplitChange],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (draggingRef.current) {
        setFromPointer(event.clientX);
      }
    };
    const onPointerUp = () => {
      draggingRef.current = false;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [setFromPointer]);

  return (
    <section ref={containerRef} className={`flex min-h-0 flex-col overflow-hidden sm:flex-row ${className ?? ""}`}>
      <div className="flex min-h-0 flex-1 sm:h-full sm:basis-[var(--split)] sm:flex-none" style={splitStyle}>
        {children[0]}
      </div>
      <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={minSplit}
        aria-valuemax={maxSplit}
        aria-valuenow={Math.round(split)}
        className="group relative hidden w-2 shrink-0 cursor-col-resize border-x border-white/10 bg-cyan/10 outline-none transition hover:bg-cyan/20 focus:bg-cyan/20 sm:block"
        aria-label={label}
        title="Resize panes"
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          setFromPointer(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            onSplitChange(clamp(split - 5, minSplit, maxSplit));
          }
          if (event.key === "ArrowRight") {
            onSplitChange(clamp(split + 5, minSplit, maxSplit));
          }
          if (event.key === "Home") {
            onSplitChange(minSplit);
          }
          if (event.key === "End") {
            onSplitChange(maxSplit);
          }
        }}
      >
        <span className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan/35 transition group-hover:bg-cyan-strong/80 group-focus:bg-cyan-strong/80" />
      </button>
      <div className="flex min-h-0 flex-1 sm:h-full">{children[1]}</div>
    </section>
  );
}

function ChatPane({
  chat,
  prompt,
  runState,
  onPromptChange,
  onSend,
  onAbort,
  onReset,
}: {
  chat: ChatMessage[];
  prompt: string;
  runState: RunState;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onReset: () => void;
}) {
  const streaming = runState === "streaming";

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden border-b border-white/10 sm:border-b-0">
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3">
        <div>
          <h2 className="text-sm font-black text-white">Chat</h2>
          <p className="text-xs text-muted">Protocol text transcript</p>
        </div>
        <button type="button" className="btn-secondary min-h-9 px-2 text-xs" onClick={onReset}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Clear
        </button>
      </div>
      <div data-testid="chat-transcript-scroll" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-2.5 [scrollbar-gutter:stable]">
        {chat.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <p className="text-sm font-black text-white">No run yet.</p>
              <p className="mt-2 text-sm leading-6 text-muted">
                Connect an A2A endpoint, send a prompt, and inspect every stream frame beside the rendered A2UI surface.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {chat.map((message) => (
              <article
                key={message.id}
                className={`rounded-lg border p-3 ${
                  message.role === "user"
                    ? "border-cyan/25 bg-cyan/10"
                    : message.role === "system"
                      ? "border-violet/30 bg-violet/10"
                      : "border-white/10 bg-white/[0.045]"
                }`}
              >
                <p className="mb-1 text-[10px] font-black uppercase tracking-[0.12em] text-muted">{message.role}</p>
                <ChatMarkdown text={message.text} />
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-white/10 p-2.5">
        <label className="grid gap-2">
          <span className="text-xs font-black text-muted">Prompt</span>
          <textarea
            className="workbench-input max-h-28 min-h-[4.5rem] resize-none text-sm leading-6"
            value={prompt}
            placeholder="Ask the upstream agent for A2UI output."
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onSend();
              }
            }}
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={!prompt.trim() || streaming} onClick={onSend}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Send
          </button>
          <button type="button" className="btn-danger" disabled={!streaming} onClick={onAbort}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Abort
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={chatMarkdownPlugins} components={chatMarkdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function A2uiStage({ surfaces }: { surfaces: SurfaceModel<ReactComponentImplementation>[] }) {
  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3">
        <div>
          <h2 className="text-sm font-black text-white">A2UI Stage</h2>
          <p className="text-xs text-muted">React v0.9 renderer</p>
        </div>
        <div className="rounded-lg border border-blue/30 bg-blue/10 px-3 py-1.5 font-mono text-xs text-blue">
          {surfaces.length} surfaces
        </div>
      </div>
      <MarkdownContext.Provider value={renderSafeMarkdown}>
        <div className="a2ui-stage min-h-0 flex-1 overflow-auto overscroll-contain bg-graphite-950/35 p-3">
          {surfaces.length === 0 ? (
            <div className="grid h-full place-items-center text-center">
              <div className="max-w-md p-6">
                <p className="text-sm font-black text-white">Waiting for A2UI.</p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Envelopes with `application/a2ui+json` or fenced `a2ui` blocks will render here.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              {surfaces.map((surface) => (
                <div key={surface.id} className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                  <div className="mb-3 font-mono text-[11px] text-muted">surface: {surface.id}</div>
                  <A2uiSurface surface={surface} />
                </div>
              ))}
            </div>
          )}
        </div>
      </MarkdownContext.Provider>
    </section>
  );
}

function ProtocolInspector({
  activeTab,
  onTabChange,
  timeline,
  errors,
  requestInfo,
  rawFrames,
  a2aFrames,
  a2uiEvents,
  meta,
  status,
  clientActions,
  counts,
}: {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  timeline: TimelineEntry[];
  errors: WorkbenchError[];
  requestInfo: unknown;
  rawFrames: unknown[];
  a2aFrames: unknown[];
  a2uiEvents: unknown[];
  meta: A2aMeta;
  status?: A2aStatus;
  clientActions: ClientActionEntry[];
  counts: { raw: number; a2a: number; a2ui: number; errors: number };
}) {
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "run", label: "Run" },
    { id: "request", label: "Request" },
    { id: "raw", label: "Raw" },
    { id: "a2a", label: "A2A" },
    { id: "a2ui", label: "A2UI" },
    { id: "meta", label: "Meta" },
  ];

  return (
    <aside className="flex min-h-0 w-full flex-col overflow-hidden border-t border-white/10 sm:border-t-0">
      <div className="shrink-0 border-b border-white/10 p-3">
        <h2 className="text-sm font-black text-white">Protocol Inspector</h2>
        <div className="mt-3 flex gap-1 overflow-x-auto pb-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="tab-button shrink-0"
              data-active={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3">
        {activeTab === "run" ? <RunTab timeline={timeline} errors={errors} counts={counts} /> : null}
        {activeTab === "request" ? <JsonPanel value={requestInfo ?? { message: "No request emitted yet." }} /> : null}
        {activeTab === "raw" ? <JsonPanel value={rawFrames} /> : null}
        {activeTab === "a2a" ? <JsonPanel value={a2aFrames} /> : null}
        {activeTab === "a2ui" ? <JsonPanel value={a2uiEvents} /> : null}
        {activeTab === "meta" ? (
          <JsonPanel
            value={{
              meta,
              status,
              clientActions,
            }}
          />
        ) : null}
      </div>
    </aside>
  );
}

function RunTab({
  timeline,
  errors,
  counts,
}: {
  timeline: TimelineEntry[];
  errors: WorkbenchError[];
  counts: { raw: number; a2a: number; a2ui: number; errors: number };
}) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Raw" value={counts.raw} />
        <Metric label="A2A" value={counts.a2a} />
        <Metric label="A2UI" value={counts.a2ui} />
        <Metric label="Errors" value={counts.errors} tone={counts.errors > 0 ? "alert" : "normal"} />
      </div>
      <section>
        <h3 className="mb-2 text-xs font-black text-white">Errors</h3>
        {errors.length === 0 ? (
          <p className="rounded-lg border border-white/10 bg-white/[0.035] p-3 text-sm text-muted">No errors recorded.</p>
        ) : (
          <div className="grid gap-2">
            {errors.map((error, index) => (
              <div key={`${error.message}-${index}`} className="rounded-lg border border-violet/25 bg-violet/10 p-3">
                <p className="text-sm font-bold text-white">{error.message}</p>
                {error.detail ? <pre className="mt-2 overflow-auto text-xs text-muted">{stringify(error.detail)}</pre> : null}
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-xs font-black text-white">Timeline</h3>
        {timeline.length === 0 ? (
          <p className="rounded-lg border border-white/10 bg-white/[0.035] p-3 text-sm text-muted">No stream events yet.</p>
        ) : (
          <div className="grid gap-2">
            {timeline
              .slice()
              .reverse()
              .map((entry) => (
                <div key={entry.id} className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-black text-cyan-strong">{entry.type}</span>
                    <span className="font-mono text-[11px] text-muted">{entry.time}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{entry.summary}</p>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}

function JsonPanel({ value }: { value: unknown }) {
  return (
    <pre className="min-h-full overflow-auto rounded-lg border border-white/10 bg-graphite-950/70 p-3 font-mono text-[11px] leading-5 text-muted">
      {stringify(value)}
    </pre>
  );
}

async function renderSafeMarkdown(markdown: string): Promise<string> {
  const escaped = escapeHtml(markdown);
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br />")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readPersistedConnection(): PersistedConnection | undefined {
  const raw = window.localStorage.getItem(CONNECTION_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as PersistedConnection;
    return {
      upstream: typeof parsed.upstream === "string" ? parsed.upstream : "",
      a2uiTrigger: typeof parsed.a2uiTrigger === "string" ? parsed.a2uiTrigger : DEFAULT_A2UI_TRIGGER,
      headers: Array.isArray(parsed.headers) ? parsed.headers.filter(isPersistedHeader) : [],
      oauth: isPersistedOAuth(parsed.oauth) ? parsed.oauth : defaultM2mOAuth,
    };
  } catch {
    return undefined;
  }
}

function isPersistedHeader(value: unknown): value is PersistedHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as PersistedHeader;
  return typeof candidate.name === "string" && typeof candidate.value === "string";
}

function stripHeaderIds(headers: HeaderRow[]): PersistedHeader[] {
  return headers.map((header) => ({
    name: header.name,
    value: header.value,
    enabled: header.enabled,
    secret: header.secret,
  }));
}

function isPersistedOAuth(value: unknown): value is PersistedM2mOAuth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as PersistedM2mOAuth;
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.tokenUrl === "string" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.clientSecret === "string" &&
    typeof candidate.scope === "string" &&
    typeof candidate.audience === "string" &&
    (candidate.authMethod === "client_secret_basic" || candidate.authMethod === "client_secret_post")
  );
}

function getCreateSurfaceIds(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return [];
    }

    const createSurface = (message as { createSurface?: unknown }).createSurface;
    if (typeof createSurface !== "object" || createSurface === null || Array.isArray(createSurface)) {
      return [];
    }

    const surfaceId = (createSurface as { surfaceId?: unknown }).surfaceId;
    return typeof surfaceId === "string" ? [surfaceId] : [];
  });
}

function readEventText(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const text = (data as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function readA2uiMessages(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [];
  }
  const messages = (data as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function summarizeEvent(data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.state === "string") {
      return record.state;
    }
    if (typeof record.text === "string") {
      return record.text;
    }
  }

  return stringify(data).slice(0, 220);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || href.startsWith("mailto:");
}

function limitList<T>(values: T[], limit: number): T[] {
  return values.slice(Math.max(0, values.length - limit));
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
