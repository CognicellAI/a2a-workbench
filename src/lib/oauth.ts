import { createHash } from "node:crypto";
import type { NormalizedM2mOAuth } from "@/lib/workbench-types";
import { redactSecrets } from "@/lib/redaction";

export type OAuthTokenResponse = {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
};

type TokenEndpointError = {
  message: string;
  status?: number;
  detail?: unknown;
};

export class OAuthTokenError extends Error {
  readonly status?: number;
  readonly detail?: unknown;

  constructor({ message, status, detail }: TokenEndpointError) {
    super(message);
    this.name = "OAuthTokenError";
    this.status = status;
    this.detail = detail;
  }
}

type CachedOAuthToken = OAuthTokenResponse & {
  expiresAtMs: number;
};

const TOKEN_EXPIRY_SKEW_MS = 30_000;
const tokenCache = new Map<string, CachedOAuthToken>();

export async function getM2mOAuthToken(oauth: NormalizedM2mOAuth, signal?: AbortSignal): Promise<OAuthTokenResponse> {
  const cacheKey = tokenCacheKey(oauth);
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return {
      accessToken: cached.accessToken,
      tokenType: cached.tokenType,
      expiresIn: Math.max(0, Math.ceil((cached.expiresAtMs - Date.now()) / 1000)),
    };
  }

  const token = await fetchM2mOAuthToken(oauth, signal);
  if (typeof token.expiresIn === "number" && token.expiresIn * 1000 > TOKEN_EXPIRY_SKEW_MS) {
    tokenCache.set(cacheKey, {
      ...token,
      expiresAtMs: Date.now() + token.expiresIn * 1000,
    });
  } else {
    tokenCache.delete(cacheKey);
  }

  return token;
}

export function clearM2mOAuthTokenCache(): void {
  tokenCache.clear();
}

export async function fetchM2mOAuthToken(oauth: NormalizedM2mOAuth, signal?: AbortSignal): Promise<OAuthTokenResponse> {
  const body = buildTokenRequestBody(oauth);
  const headers = buildTokenRequestHeaders(oauth);

  const response = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers,
    body,
    signal,
  });

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new OAuthTokenError({
      message: "OAuth token endpoint rejected the client credentials request.",
      status: response.status,
      detail: redactSecrets(payload ?? text.slice(0, 1200)),
    });
  }

  if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new OAuthTokenError({
      message: "OAuth token endpoint did not return an access_token.",
      status: response.status,
      detail: redactSecrets(payload ?? text.slice(0, 1200)),
    });
  }

  return {
    accessToken: payload.access_token,
    tokenType: typeof payload.token_type === "string" && payload.token_type.trim() ? payload.token_type : "Bearer",
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
  };
}

function buildTokenRequestBody(oauth: NormalizedM2mOAuth): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");

  if (oauth.authMethod === "client_secret_post") {
    body.set("client_id", oauth.clientId);
    body.set("client_secret", oauth.clientSecret);
  }

  if (oauth.scope) {
    body.set("scope", oauth.scope);
  }

  if (oauth.audience) {
    body.set("audience", oauth.audience);
  }

  return body;
}

function buildTokenRequestHeaders(oauth: NormalizedM2mOAuth): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/x-www-form-urlencoded");

  if (oauth.authMethod === "client_secret_basic") {
    headers.set("Authorization", `Basic ${basicAuth(oauth.clientId, oauth.clientSecret)}`);
  }

  return headers;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

function tokenCacheKey(oauth: NormalizedM2mOAuth): string {
  return JSON.stringify({
    tokenUrl: oauth.tokenUrl,
    clientId: oauth.clientId,
    clientSecretHash: createHash("sha256").update(oauth.clientSecret).digest("hex"),
    scope: oauth.scope,
    audience: oauth.audience,
    authMethod: oauth.authMethod,
  });
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
