"use client";

import { useEffect } from "react";
import {
  A2uiSurface,
  MarkdownContext,
  type ReactComponentImplementation,
} from "@a2ui/react/v0_9";
import { injectStyles, removeStyles } from "@a2ui/react/styles";
import type { SurfaceModel } from "@a2ui/web_core/v0_9";

export function A2uiStage({ surfaces }: { surfaces: SurfaceModel<ReactComponentImplementation>[] }) {
  useEffect(() => {
    injectStyles();
    return () => removeStyles();
  }, []);

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

async function renderSafeMarkdown(markdown: string): Promise<string> {
  return markdown
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br />")}</p>`)
    .join("");
}
