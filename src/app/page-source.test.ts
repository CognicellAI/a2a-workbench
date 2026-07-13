import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("workbench source guardrails", () => {
  it("renders the workbench as the first screen", () => {
    const page = readFileSync(join(root, "src/app/page.tsx"), "utf8");

    expect(page).toContain("WorkbenchClient");
    expect(page).not.toContain("Create Next App");
  });

  it("keeps protocol counters in the inspector and status areas", () => {
    const source = readFileSync(join(root, "src/components/workbench-client.tsx"), "utf8");

    expect(source).toContain("Protocol Inspector");
    expect(source).toContain('label="Raw"');
    expect(source).toContain('label="A2A"');
    expect(source).toContain('label="A2UI"');
    expect(source).not.toMatch(/promptSelections|premadePrompts|examplePrompts/);
  });

  it("uses a no-page-scroll 100dvh shell", () => {
    const source = readFileSync(join(root, "src/components/workbench-client.tsx"), "utf8");
    const css = readFileSync(join(root, "src/app/globals.css"), "utf8");

    expect(source).toContain("h-[100dvh]");
    expect(source).toContain("overflow-hidden p-2 text-ink");
    expect(css).toContain("overflow: hidden");
  });

  it("keeps the chat transcript in its own local scroll region", () => {
    const source = readFileSync(join(root, "src/components/workbench-client.tsx"), "utf8");

    expect(source).toContain('data-testid="chat-transcript-scroll"');
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("[scrollbar-gutter:stable]");
  });

  it("renders chat markdown without raw HTML injection", () => {
    const source = readFileSync(join(root, "src/components/workbench-client.tsx"), "utf8");

    expect(source).toContain('from "react-markdown"');
    expect(source).toContain('from "remark-gfm"');
    expect(source).toContain("function ChatMarkdown");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("contains the workbench visual tokens", () => {
    const css = readFileSync(join(root, "src/app/globals.css"), "utf8");

    expect(css).toContain("#06080d");
    expect(css).toContain("#11f0f0");
    expect(css).toContain("#ba50e0");
    expect(css).toContain("#4771f0");
  });
});
