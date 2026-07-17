import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const architectureRoot = join(root, "docs", "architecture");
const markdownFiles = [
  join(root, "DESIGN.md"),
  join(root, "README.md"),
  join(root, "SECURITY.md"),
  join(root, "packages", "client", "README.md"),
  join(root, "conformance", "README.md"),
  ...walk(architectureRoot).filter((file) => extname(file) === ".md"),
];
const failures = [];

for (const file of markdownFiles) validateLinks(file);
validateC4ElementIds();
renderMermaid();
run("npx", ["tsc", "-p", "docs/architecture/tsconfig.examples.json", "--noEmit"], "public API examples");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Documentation checks passed: ${markdownFiles.length} Markdown files and all Mermaid diagrams.`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function validateLinks(file) {
  const content = readFileSync(file, "utf8");
  const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
    const [pathPart] = raw.split("#", 1);
    const target = resolve(dirname(file), decodeURIComponent(pathPart));
    if (!existsSync(target)) {
      failures.push(`${relative(root, file)} links to missing ${raw}`);
    }
  }
}

function validateC4ElementIds() {
  const c4Paths = [
    join(architectureRoot, "c4-model.md"),
    join(architectureRoot, "frontend-c4-model.md"),
  ];
  const catalogOwners = new Map();
  const blocks = [];

  for (const c4Path of c4Paths) {
    const content = readFileSync(c4Path, "utf8");
    const owner = relative(root, c4Path);
    const ids = [...content.matchAll(/^\| `((?:ACT|SYS|CTR|LIB|CMP|EXT)-[A-Z0-9-]+)` \|/gm)].map(
      (match) => match[1],
    );
    for (const id of ids) {
      const existingOwner = catalogOwners.get(id);
      if (existingOwner) {
        failures.push(`C4 element ID ${id} is cataloged by both ${existingOwner} and ${owner}`);
      } else {
        catalogOwners.set(id, owner);
      }
    }
    blocks.push(...[...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((match) => match[1]));
  }

  const referenced = new Set(
    blocks.flatMap((block) => [...block.matchAll(/\b(?:ACT|SYS|CTR|LIB|CMP|EXT)-[A-Z0-9-]+\b/g)].map((match) => match[0])),
  );
  for (const id of referenced) {
    if (!catalogOwners.has(id)) failures.push(`C4 diagram references uncatalogued element ID ${id}`);
  }
  for (const id of catalogOwners.keys()) {
    if (!referenced.has(id)) failures.push(`C4 catalog element ${id} is not used in a diagram`);
  }
}

function renderMermaid() {
  const blocks = markdownFiles.flatMap((file) => {
    const content = readFileSync(file, "utf8");
    return [...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((match, index) => ({
      source: `${relative(root, file)}#diagram-${index + 1}`,
      body: match[1],
    }));
  });
  if (blocks.length === 0) {
    failures.push("No Mermaid diagrams were found");
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "a2a-docs-"));
  try {
    const input = join(temporary, "diagrams.md");
    const output = join(temporary, "rendered.md");
    const puppeteerConfig = join(temporary, "puppeteer.json");
    writeFileSync(input, blocks.map((block) => `## ${block.source}\n\n\`\`\`mermaid\n${block.body}\`\`\`\n`).join("\n"));
    writeFileSync(puppeteerConfig, JSON.stringify({ args: ["--no-sandbox"] }));
    run(
      join(root, "node_modules", ".bin", "mmdc"),
      ["--input", input, "--output", output, "--quiet", "--puppeteerConfigFile", puppeteerConfig],
      "Mermaid rendering",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${label} failed:\n${result.stdout}${result.stderr}`);
  }
}
