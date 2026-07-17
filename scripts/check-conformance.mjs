import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "conformance/client-requirements.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const expectedLabel = "A2A v1 client conformance — spec/TCK-derived";
const allowedStatuses = new Set(["implemented", "tested", "not-applicable"]);

if (manifest.reportLabel !== expectedLabel) failures.push(`reportLabel must be ${expectedLabel}`);
if (manifest.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (!manifest.sources?.specification?.revision || !manifest.sources?.tck?.revision) {
  failures.push("specification and TCK revisions must be pinned");
}
if (manifest.sources?.javascriptSdk?.package !== "@a2a-js/sdk@1.0.0-beta.0") {
  failures.push("JavaScript SDK source must match the exact package pin");
}

const schemaPath = resolve(root, manifest.sources?.schemaSnapshot?.path ?? "");
if (!existsSync(schemaPath)) {
  failures.push("vendored schema snapshot is missing");
} else {
  const digest = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
  if (digest !== manifest.sources.schemaSnapshot.sha256) failures.push("vendored schema snapshot digest changed");
}

const c4 = readFileSync(resolve(root, "docs/architecture/c4-model.md"), "utf8");
const owners = new Set(
  [...c4.matchAll(/^\| `((?:ACT|SYS|CTR|LIB|CMP|EXT)-[A-Z0-9-]+)` \|/gm)].map((match) => match[1]),
);
const ids = new Set();
for (const requirement of manifest.requirements ?? []) {
  if (!requirement.id || ids.has(requirement.id)) failures.push(`duplicate or missing requirement ID ${requirement.id}`);
  ids.add(requirement.id);
  if (!allowedStatuses.has(requirement.status)) failures.push(`${requirement.id} has invalid status ${requirement.status}`);

  if (requirement.applicable) {
    if (requirement.status === "not-applicable") failures.push(`${requirement.id} is applicable but marked not-applicable`);
    if (!Array.isArray(requirement.architectureOwners) || requirement.architectureOwners.length === 0) {
      failures.push(`${requirement.id} lacks an architecture owner`);
    }
    if (!Array.isArray(requirement.tests) || requirement.tests.length === 0) {
      failures.push(`${requirement.id} lacks an executable test`);
    }
    for (const owner of requirement.architectureOwners ?? []) {
      if (!owners.has(owner)) failures.push(`${requirement.id} references unknown C4 owner ${owner}`);
    }
    for (const test of requirement.tests ?? []) validateTestReference(requirement.id, test);
  } else {
    if (requirement.status !== "not-applicable") failures.push(`${requirement.id} must be marked not-applicable`);
    if (!requirement.reason?.trim()) failures.push(`${requirement.id} lacks a not-applicable reason`);
  }
}

if (!Array.isArray(manifest.unsupported) || manifest.unsupported.some((item) => !item.feature || !item.reason)) {
  failures.push("unsupported features must include a feature and reason");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
const applicable = manifest.requirements.filter((requirement) => requirement.applicable).length;
const notApplicable = manifest.requirements.length - applicable;
console.log(`Conformance manifest passed: ${applicable} applicable mappings, ${notApplicable} justified exclusions.`);

function validateTestReference(requirementId, reference) {
  const separator = reference.indexOf("#");
  const relativePath = separator >= 0 ? reference.slice(0, separator) : reference;
  const anchor = separator >= 0 ? reference.slice(separator + 1) : "";
  const path = resolve(root, relativePath);
  if (!path.startsWith(root) || !existsSync(path)) {
    failures.push(`${requirementId} test file does not exist: ${relativePath}`);
    return;
  }
  if (anchor && !readFileSync(path, "utf8").includes(anchor)) {
    failures.push(`${requirementId} test anchor is missing from ${relativePath}: ${anchor}`);
  }
}
