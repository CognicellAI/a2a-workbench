import { A2aClientError } from "./errors.js";
import { DefaultUrlPolicy } from "./network.js";
import type {
  AgentCard,
  Clock,
  Credential,
  CredentialProvider,
  CredentialRequest,
  OAuth2ClientCredential,
  SecurityRequirement,
  SecurityScheme,
  StaticCredentialProviderOptions,
  UrlPolicy,
} from "./types.js";

const systemClock: Clock = { now: () => Date.now() };

type TokenCacheEntry = { readonly token: string; readonly tokenType: string; readonly expiresAt: number };

export class StaticCredentialProvider implements CredentialProvider {
  readonly #credentials: Readonly<Record<string, Credential>>;
  readonly #fetch: typeof fetch;
  readonly #urlPolicy: UrlPolicy;
  readonly #clock: Clock;
  readonly #defaultHeaders: Readonly<Record<string, string>>;
  readonly #tokens = new Map<string, TokenCacheEntry>();

  constructor(
    credentials: Readonly<Record<string, Credential>>,
    options: StaticCredentialProviderOptions = {},
  ) {
    this.#credentials = credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#urlPolicy = options.urlPolicy ?? new DefaultUrlPolicy();
    this.#clock = options.clock ?? systemClock;
    this.#defaultHeaders = options.defaultHeaders ?? {};
  }

  canProvide(schemeName: string, scheme: SecurityScheme): boolean {
    const credential = this.#credentials[schemeName];
    if (!credential) return false;
    if (!isSupportedAuthenticationScheme(scheme)) return false;
    if (credential.type === "customHeaders") return true;
    if ("apiKeySecurityScheme" in scheme) {
      return credential.type === "apiKey" && scheme.apiKeySecurityScheme.location.toLowerCase() === "header";
    }
    if ("httpAuthSecurityScheme" in scheme) {
      const protocol = scheme.httpAuthSecurityScheme.scheme.toLowerCase();
      return (protocol === "basic" && credential.type === "basic") ||
        (protocol === "bearer" && credential.type === "bearer");
    }
    return "oauth2SecurityScheme" in scheme && credential.type === "oauth2ClientCredentials" &&
      Boolean(scheme.oauth2SecurityScheme.flows?.clientCredentials);
  }

  async getHeaders(request: CredentialRequest): Promise<Readonly<Record<string, string>>> {
    const headers = new Headers(this.#defaultHeaders);
    const entries = Object.entries(request.requirement?.schemes ?? {});
    for (const [schemeName, scopeList] of entries) {
      const scheme = request.agentCard.securitySchemes?.[schemeName];
      const credential = this.#credentials[schemeName];
      if (!scheme || !credential) {
        throw new A2aClientError("AUTHENTICATION_FAILED", `Credentials unavailable for ${schemeName}`, {
          operation: request.operation,
        });
      }
      const resolved = await this.#headersForCredential(
        schemeName,
        scheme,
        credential,
        scopeList.list,
        request,
      );
      Object.entries(resolved).forEach(([name, value]) => headers.set(name, value));
    }
    return Object.fromEntries(headers.entries());
  }

  async #headersForCredential(
    schemeName: string,
    scheme: SecurityScheme,
    credential: Credential,
    scopes: readonly string[],
    request: CredentialRequest,
  ): Promise<Readonly<Record<string, string>>> {
    if (credential.type === "customHeaders") return credential.headers;
    if ("apiKeySecurityScheme" in scheme && credential.type === "apiKey") {
      return { [scheme.apiKeySecurityScheme.name]: credential.value };
    }
    if ("httpAuthSecurityScheme" in scheme && credential.type === "basic") {
      return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}` };
    }
    if ("httpAuthSecurityScheme" in scheme && credential.type === "bearer") {
      return { Authorization: `Bearer ${credential.token}` };
    }
    if ("oauth2SecurityScheme" in scheme && credential.type === "oauth2ClientCredentials") {
      const token = await this.#oauthToken(schemeName, scheme, credential, scopes, request);
      return { Authorization: `${token.tokenType} ${token.token}` };
    }
    throw new A2aClientError("AUTHENTICATION_FAILED", `Credential type does not satisfy ${schemeName}`, {
      operation: request.operation,
    });
  }

  async #oauthToken(
    schemeName: string,
    scheme: Extract<SecurityScheme, { readonly oauth2SecurityScheme: unknown }>,
    credential: OAuth2ClientCredential,
    scopes: readonly string[],
    request: CredentialRequest,
  ): Promise<TokenCacheEntry> {
    const cached = this.#tokens.get(schemeName);
    if (cached && cached.expiresAt > this.#clock.now() + 30_000) return cached;

    const flow = scheme.oauth2SecurityScheme.flows?.clientCredentials;
    const tokenUrl = credential.tokenUrl ?? flow?.tokenUrl;
    if (!tokenUrl) {
      throw new A2aClientError("AUTHENTICATION_FAILED", `OAuth2 token URL missing for ${schemeName}`, {
        operation: request.operation,
      });
    }
    const url = new URL(tokenUrl);
    await this.#urlPolicy.assertAllowed(url, { purpose: "oauth" });
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (scopes.length > 0) body.set("scope", scopes.join(" "));
    if (credential.audience) body.set("audience", credential.audience);

    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    if ((credential.authMethod ?? "client_secret_basic") === "client_secret_basic") {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${credential.clientId}:${credential.clientSecret}`).toString("base64")}`,
      );
    } else {
      body.set("client_id", credential.clientId);
      body.set("client_secret", credential.clientSecret);
    }

    const response = await this.#fetch(url, { method: "POST", headers, body, signal: request.signal, redirect: "error" });
    if (!response.ok) {
      throw new A2aClientError("AUTHENTICATION_FAILED", `OAuth2 token request failed with ${response.status}`, {
        operation: request.operation,
        httpStatus: response.status,
      });
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new A2aClientError("AUTHENTICATION_FAILED", "OAuth2 token response did not contain access_token", {
        operation: request.operation,
      });
    }
    const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 300;
    const entry = {
      token: payload.access_token,
      tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : "Bearer",
      expiresAt: this.#clock.now() + expiresIn * 1000,
    };
    this.#tokens.set(schemeName, entry);
    return entry;
  }
}

export function createStaticCredentialProvider(
  credentials: Readonly<Record<string, Credential>>,
  options?: StaticCredentialProviderOptions,
): CredentialProvider {
  return new StaticCredentialProvider(credentials, options);
}

export function selectSecurityRequirement(
  card: AgentCard,
  provider: CredentialProvider | undefined,
): SecurityRequirement | undefined {
  const requirements = card.securityRequirements ?? [];
  if (requirements.length === 0) return undefined;
  if (!provider) {
    throw new A2aClientError("UNSUPPORTED_AUTHENTICATION", "Agent requires authentication but no provider was configured", {
      operation: "discover",
    });
  }

  const selected = requirements.find((requirement) =>
    Object.entries(requirement.schemes).every(([schemeName, scopes]) => {
      const scheme = card.securitySchemes?.[schemeName];
      return scheme && isSupportedAuthenticationScheme(scheme)
        ? provider.canProvide(schemeName, scheme, scopes.list)
        : false;
    }),
  );
  if (!selected) {
    throw new A2aClientError(
      "UNSUPPORTED_AUTHENTICATION",
      "No declared security requirement can be fully satisfied",
      { operation: "discover" },
    );
  }
  return selected;
}

function isSupportedAuthenticationScheme(scheme: SecurityScheme): boolean {
  if ("apiKeySecurityScheme" in scheme) {
    return scheme.apiKeySecurityScheme.location.toLowerCase() === "header";
  }
  if ("httpAuthSecurityScheme" in scheme) {
    const protocol = scheme.httpAuthSecurityScheme.scheme.toLowerCase();
    return protocol === "basic" || protocol === "bearer";
  }
  if ("oauth2SecurityScheme" in scheme) {
    return Boolean(scheme.oauth2SecurityScheme.flows?.clientCredentials);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
