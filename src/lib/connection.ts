import type {
  ConnectionProfileInput,
  HeaderInput,
  M2mOAuthAuthMethod,
  M2mOAuthInput,
  NormalizedConnection,
  NormalizedHeader,
  NormalizedM2mOAuth,
  PersistedConnection,
} from "@/lib/workbench-types";

export const DEFAULT_A2UI_TRIGGER = "[a2ui]";
export const DEFAULT_SCOPE_HEADER = "X-A2A-Scope-User";
export const DEFAULT_M2M_OAUTH_AUTH_METHOD = "client_secret_basic";

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SECRET_HEADER_PATTERN = /(authorization|api[-_ ]?key|apikey|token|secret|credential|password|bearer)/i;
const OAUTH_AUTH_METHODS = ["client_secret_basic", "client_secret_post"] as const;

type EnvLike = Record<string, string | undefined>;

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export function normalizeConnection(
  raw: ConnectionProfileInput | undefined,
  env: EnvLike = process.env,
): NormalizedConnection {
  const input = isRecord(raw) ? raw : {};
  const upstream = normalizeUpstream(readString(input.upstream) || env.A2A_UPSTREAM);
  const a2uiTrigger = normalizeOptionalText(readString(input.a2uiTrigger) || env.A2A_A2UI_TRIGGER || DEFAULT_A2UI_TRIGGER);
  const headers = mergeHeaders(buildDefaultHeaders(env), normalizeHeaderInputs(input.headers));
  const oauth = normalizeM2mOAuth(input.oauth, env);

  return {
    upstream,
    a2uiTrigger,
    headers,
    oauth,
  };
}

export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_PATTERN.test(name);
}

export function isValidHeaderName(name: string): boolean {
  return HTTP_HEADER_NAME_PATTERN.test(name);
}

export function redactHeaders(headers: NormalizedHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.name, header.secret ? "[redacted]" : header.value]));
}

export function toPersistableConnection(connection: PersistedConnection): PersistedConnection {
  return {
    upstream: connection.upstream,
    mode: connection.mode,
    binding: connection.binding,
    a2uiTrigger: connection.a2uiTrigger,
    // A browser profile is for safe connection preferences only. Headers and
    // OAuth fields are credentials or credential configuration, so they stay
    // in memory for the current browser session.
    headers: [],
    oauth: {
      enabled: false,
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
      scope: "",
      audience: "",
      authMethod: "client_secret_basic",
    },
  };
}

export function redactM2mOAuth(oauth: NormalizedM2mOAuth | undefined): Record<string, unknown> | undefined {
  if (!oauth) {
    return undefined;
  }

  return {
    enabled: oauth.enabled,
    tokenUrl: oauth.tokenUrl,
    clientId: oauth.clientId,
    clientSecret: "[redacted]",
    scope: oauth.scope,
    audience: oauth.audience,
    authMethod: oauth.authMethod,
  };
}

function normalizeUpstream(value: string | undefined): string {
  if (!value) {
    throw new ConnectionError("Missing A2A upstream URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionError("A2A upstream must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionError("A2A upstream must use http or https.");
  }

  return url.toString();
}

function normalizeOptionalText(value: string): string {
  return value.trim();
}

function buildDefaultHeaders(env: EnvLike): NormalizedHeader[] {
  const headers: NormalizedHeader[] = [];

  if (env.A2A_API_KEY) {
    headers.push({
      name: "apikey",
      value: env.A2A_API_KEY,
      enabled: true,
      secret: true,
    });
  }

  if (env.A2A_SCOPE_USER) {
    const name = env.A2A_SCOPE_HEADER?.trim() || DEFAULT_SCOPE_HEADER;
    if (isValidHeaderName(name)) {
      headers.push({
        name,
        value: env.A2A_SCOPE_USER,
        enabled: true,
        secret: isSecretHeaderName(name),
      });
    }
  }

  return headers;
}

function normalizeHeaderInputs(headers: unknown): NormalizedHeader[] {
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers.flatMap((entry): NormalizedHeader[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const input = entry as HeaderInput;
    const name = readString(input.name)?.trim() ?? "";
    const value = readString(input.value) ?? "";
    const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
    const explicitSecret = typeof input.secret === "boolean" ? input.secret : false;

    if (!enabled || !name || !isValidHeaderName(name)) {
      return [];
    }

    return [
      {
        name,
        value,
        enabled,
        secret: explicitSecret || isSecretHeaderName(name),
      },
    ];
  });
}

function normalizeM2mOAuth(raw: unknown, env: EnvLike): NormalizedM2mOAuth | undefined {
  const input = isRecord(raw) ? (raw as M2mOAuthInput) : {};
  const envEnabled = env.A2A_OAUTH_ENABLED === "true";
  const enabled = typeof input.enabled === "boolean" ? input.enabled : envEnabled;

  if (!enabled) {
    return undefined;
  }

  const tokenUrl = normalizeOAuthUrl(readString(input.tokenUrl) || env.A2A_OAUTH_TOKEN_URL);
  const clientId = normalizeRequiredOAuthText(readString(input.clientId) || env.A2A_OAUTH_CLIENT_ID, "OAuth client ID");
  const clientSecret = normalizeRequiredOAuthText(
    readString(input.clientSecret) || env.A2A_OAUTH_CLIENT_SECRET,
    "OAuth client secret",
  );
  const scope = normalizeOptionalText(readString(input.scope) || env.A2A_OAUTH_SCOPE || "");
  const audience = normalizeOptionalText(readString(input.audience) || env.A2A_OAUTH_AUDIENCE || "");
  const authMethod = normalizeAuthMethod(readString(input.authMethod) || env.A2A_OAUTH_AUTH_METHOD);

  return {
    enabled: true,
    tokenUrl,
    clientId,
    clientSecret,
    scope,
    audience,
    authMethod,
  };
}

function normalizeOAuthUrl(value: string | undefined): string {
  if (!value) {
    throw new ConnectionError("Missing OAuth token URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionError("OAuth token URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionError("OAuth token URL must use http or https.");
  }

  return url.toString();
}

function normalizeRequiredOAuthText(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new ConnectionError(`Missing ${label}.`);
  }
  return normalized;
}

function normalizeAuthMethod(value: string | undefined): M2mOAuthAuthMethod {
  return OAUTH_AUTH_METHODS.includes(value as M2mOAuthAuthMethod)
    ? (value as M2mOAuthAuthMethod)
    : DEFAULT_M2M_OAUTH_AUTH_METHOD;
}

function mergeHeaders(defaults: NormalizedHeader[], overrides: NormalizedHeader[]): NormalizedHeader[] {
  const merged = new Map<string, NormalizedHeader>();

  [...defaults, ...overrides].forEach((header) => {
    if (header.enabled && header.value.trim()) {
      merged.set(header.name.toLowerCase(), header);
    }
  });

  return [...merged.values()];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
