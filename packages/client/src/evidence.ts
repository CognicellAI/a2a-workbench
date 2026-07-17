import type { EvidenceEvent, EvidenceSink, OperationName, SupportedBinding } from "./types.js";

const SECRET_KEY = /(authorization|proxy-authorization|cookie|set-cookie|api[-_ ]?key|apikey|token|secret|credential|password|bearer)/i;
const SAFE_PROTOCOL_METADATA_KEY = /^(?:apiKeySecurityScheme|httpAuthSecurityScheme|oauth2SecurityScheme|openIdConnectSecurityScheme|mtlsSecurityScheme|tokenUrl|refreshUrl|oauth2MetadataUrl|openIdConnectUrl|bearerFormat|clientCredentials)$/i;

export function redactEvidence(value: unknown, maxStringLength = 32_768): unknown {
  if (typeof value === "string") {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidence(item, maxStringLength));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSecretKey(key) ? "[redacted]" : redactEvidence(nested, maxStringLength),
    ]),
  );
}

function isSecretKey(key: string): boolean {
  return !SAFE_PROTOCOL_METADATA_KEY.test(key) && SECRET_KEY.test(key);
}

export async function emitEvidence(
  sink: EvidenceSink | undefined,
  input: {
    readonly kind: EvidenceEvent["kind"];
    readonly operation: OperationName;
    readonly binding?: SupportedBinding;
    readonly url?: string;
    readonly details: unknown;
  },
): Promise<void> {
  if (!sink) {
    return;
  }
  await sink.emit({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
    details: redactEvidence(input.details),
  });
}

export function headersToRecord(
  headers: Headers,
  secretHeaderNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [
      name,
      secretHeaderNames.has(name.toLowerCase()) ? "[redacted]" : value,
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
