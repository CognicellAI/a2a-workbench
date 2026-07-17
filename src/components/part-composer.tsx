"use client";

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import type { MessagePartDraft } from "@/lib/message-draft";
import type { WorkbenchMode, WorkbenchPartKind } from "@/lib/workbench-types";

const PART_KINDS: readonly { readonly value: WorkbenchPartKind; readonly label: string }[] = [
  { value: "text", label: "Text" },
  { value: "data", label: "Data JSON" },
  { value: "raw", label: "Raw content" },
  { value: "url", label: "URL" },
];

type PartComposerProps = {
  readonly parts: readonly MessagePartDraft[];
  readonly mode: WorkbenchMode;
  readonly disabled?: boolean;
  readonly onChange: (parts: readonly MessagePartDraft[]) => void;
  readonly onCreateId: () => string;
};

export function PartComposer({ parts, mode, disabled = false, onChange, onCreateId }: PartComposerProps) {
  const updatePart = (id: string, patch: Partial<MessagePartDraft>) => {
    onChange(parts.map((part) => (part.id === id ? { ...part, ...patch } : part)));
  };

  const addPart = () => {
    onChange([...parts, {
      id: onCreateId(),
      kind: "text",
      value: "",
      mediaType: "",
      filename: "",
      metadata: "",
    }]);
  };

  const movePart = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= parts.length) return;
    const next = [...parts];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const removePart = (id: string) => {
    if (parts.length === 1) return;
    onChange(parts.filter((part) => part.id !== id));
  };

  return (
    <section aria-labelledby="part-composer-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="part-composer-heading" className="text-sm font-black text-white">Message Parts</h3>
          <p className="text-xs text-muted">
            {mode === "strict"
              ? "Compose strict A2A v1 text, data, raw, and URL Parts."
              : "Compose direct-endpoint text, data, raw, and URL Parts. Compatibility evidence is non-conformant."}
          </p>
        </div>
        <button type="button" className="btn-secondary min-h-8 px-2 text-xs" disabled={disabled} onClick={addPart}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add Part
        </button>
      </div>
      <div className="grid gap-2">
        {parts.map((part, index) => (
          <article key={part.id} className="rounded-lg border border-white/10 bg-graphite-950/45 p-2.5">
            <div className="grid gap-2 md:grid-cols-[minmax(130px,0.42fr)_minmax(0,1fr)_auto] md:items-end">
              <label className="grid gap-1.5">
                <span className="text-xs font-black text-muted">Part {index + 1} type</span>
                <select
                  className="workbench-input workbench-input-compact text-xs"
                  value={part.kind}
                  disabled={disabled}
                  onChange={(event) => updatePart(part.id, { kind: event.target.value as WorkbenchPartKind, value: "" })}
                >
                  {PART_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-black text-muted">{valueLabel(part.kind)}</span>
                <textarea
                  className="workbench-input min-h-20 resize-y font-mono text-xs leading-5"
                  value={part.value}
                  disabled={disabled}
                  placeholder={valuePlaceholder(part.kind)}
                  onChange={(event) => updatePart(part.id, { value: event.target.value })}
                />
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-secondary min-h-8 px-2"
                  aria-label={`Move Part ${index + 1} up`}
                  disabled={disabled || index === 0}
                  onClick={() => movePart(index, -1)}
                >
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn-secondary min-h-8 px-2"
                  aria-label={`Move Part ${index + 1} down`}
                  disabled={disabled || index === parts.length - 1}
                  onClick={() => movePart(index, 1)}
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn-danger min-h-8 px-2"
                  aria-label={`Remove Part ${index + 1}`}
                  disabled={disabled || parts.length === 1}
                  onClick={() => removePart(part.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <label className="grid gap-1.5">
                <span className="text-xs font-black text-muted">Media type</span>
                <input
                  className="workbench-input workbench-input-compact text-xs"
                  value={part.mediaType}
                  disabled={disabled}
                  placeholder={part.kind === "data" ? "application/json" : "Optional"}
                  onChange={(event) => updatePart(part.id, { mediaType: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-black text-muted">Filename</span>
                <input
                  className="workbench-input workbench-input-compact text-xs"
                  value={part.filename}
                  disabled={disabled}
                  placeholder="Optional"
                  onChange={(event) => updatePart(part.id, { filename: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-black text-muted">Metadata JSON</span>
                <input
                  className="workbench-input workbench-input-compact font-mono text-xs"
                  value={part.metadata}
                  disabled={disabled}
                  placeholder="Optional object"
                  onChange={(event) => updatePart(part.id, { metadata: event.target.value })}
                />
              </label>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function valueLabel(kind: WorkbenchPartKind): string {
  switch (kind) {
    case "text": return "Text";
    case "data": return "JSON value";
    case "raw": return "Raw value";
    case "url": return "Absolute URL";
  }
}

function valuePlaceholder(kind: WorkbenchPartKind): string {
  switch (kind) {
    case "text": return "Ask the selected agent to perform a task.";
    case "data": return '{"key":"value"}';
    case "raw": return "Base64 or transport-specific raw content.";
    case "url": return "https://example.com/resource";
  }
}
