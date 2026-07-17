import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "packages/client/package.json"), "utf8"));
const strict = await import("@a2a-workbench/client");
const compatibility = await import("@a2a-workbench/client/compat");

assert(typeof strict.connectA2aClient === "function", "strict root export is missing connectA2aClient");
assert(typeof compatibility.connectLegacyClient === "function", "compat export is missing connectLegacyClient");
assert(packageJson.version === "0.1.0", "client package version must be 0.1.0");
assert(packageJson.type === "module", "client package must be ESM-only");
assert(packageJson.engines?.node === ">=20", "client package must require Node.js 20+");
assert(packageJson.dependencies?.["@a2a-js/sdk"] === "1.0.0-beta.0", "A2A SDK must be pinned exactly");
assert(!packageJson.dependencies?.react && !packageJson.dependencies?.next, "client package cannot depend on React or Next.js");

let internalBlocked = false;
try {
  await import("@a2a-workbench/client/client.js");
} catch (error) {
  internalBlocked = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}
assert(internalBlocked, "client package internals must not be importable");

const workbenchFiles = walk(join(root, "src")).filter((file) => [".ts", ".tsx"].includes(extname(file)));
for (const file of workbenchFiles) {
  const content = readFileSync(file, "utf8");
  const imports = [...content.matchAll(/from\s+["'](@a2a-workbench\/client\/[^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of imports) {
    assert(specifier === "@a2a-workbench/client/compat", `workbench imports private client path ${specifier}`);
  }
}

console.log("Client package export, runtime, dependency, and boundary smoke checks passed.");

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
