import { AgentCard as SdkAgentCard, verifyAgentCardSignature } from "@a2a-js/sdk";
import { A2aClientError, asA2aClientError } from "./errors.js";
import { emitEvidence } from "./evidence.js";
import { createPolicyFetch, readResponseText } from "./network.js";
import type {
  AgentCard,
  AgentCardCache,
  CardCacheState,
  CardTrustState,
  Clock,
  EvidenceSink,
  SignatureTrustStore,
  UrlPolicy,
} from "./types.js";
import { validateAgentCard } from "./validation.js";

export type DiscoveryOptions = {
  readonly agentUrl: string | URL;
  readonly agentCardPath?: string;
  readonly cache: AgentCardCache;
  readonly trustStore?: SignatureTrustStore;
  readonly fetchImpl: typeof fetch;
  readonly clock: Clock;
  readonly urlPolicy: UrlPolicy;
  readonly evidenceSink?: EvidenceSink;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
};

export type DiscoveredAgentCard = {
  readonly card: AgentCard;
  readonly cardUrl: string;
  readonly cache: CardCacheState;
  readonly trust: CardTrustState;
};

export async function discoverAgentCard(options: DiscoveryOptions): Promise<DiscoveredAgentCard> {
  const cardUrl = resolveAgentCardUrl(options.agentUrl, options.agentCardPath);
  const cached = await options.cache.get(cardUrl.href);
  const now = options.clock.now();
  if (!options.forceRefresh && cached && !cached.mustRevalidate && cached.expiresAt > now) {
    await emitEvidence(options.evidenceSink, {
      kind: "decision",
      operation: "discover",
      url: cardUrl.href,
      details: { cache: "fresh", trust: cached.trust },
    });
    return { card: structuredClone(cached.card), cardUrl: cardUrl.href, cache: "fresh", trust: cached.trust };
  }

  const headers = new Headers({
    Accept: "application/json, application/a2a+json",
    "A2A-Version": "1.0",
  });
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

  try {
    const policyFetch = createPolicyFetch({
      fetchImpl: options.fetchImpl,
      urlPolicy: options.urlPolicy,
      evidenceSink: options.evidenceSink,
      operation: "discover",
      purpose: "discovery",
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      maxRedirects: options.maxRedirects,
    });
    const response = await policyFetch(cardUrl, { headers, signal: options.signal });

    if (response.status === 304) {
      if (!cached) {
        throw new A2aClientError("CACHE_REVALIDATION_FAILED", "Agent Card returned 304 without a cache entry", {
          operation: "discover",
          httpStatus: 304,
        });
      }
      const metadata = cacheMetadata(response.headers, now, cached);
      await options.cache.set(cardUrl.href, { ...cached, ...metadata, storedAt: now });
      return {
        card: structuredClone(cached.card),
        cardUrl: cardUrl.href,
        cache: "revalidated",
        trust: cached.trust,
      };
    }

    if (!response.ok) {
      throw new A2aClientError("DISCOVERY_FAILED", `Agent Card discovery returned HTTP ${response.status}`, {
        operation: "discover",
        httpStatus: response.status,
        retryable: response.status >= 500,
      });
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("json")) {
      throw new A2aClientError("AGENT_CARD_INVALID", `Agent Card response was not JSON (${contentType})`, {
        operation: "discover",
        httpStatus: response.status,
      });
    }

    const text = await readResponseText(response, options.maxResponseBytes, "discover");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new A2aClientError("AGENT_CARD_INVALID", "Agent Card response contained invalid JSON", {
        operation: "discover",
        cause: error,
      });
    }
    const card = validateAgentCard(payload);
    const trust = await verifyCardTrust(card, options.trustStore);
    const metadata = cacheMetadata(response.headers, now);

    if (metadata.noStore) {
      await options.cache.delete(cardUrl.href);
    } else {
      await options.cache.set(cardUrl.href, {
        card,
        storedAt: now,
        expiresAt: metadata.expiresAt,
        mustRevalidate: metadata.mustRevalidate,
        etag: metadata.etag,
        lastModified: metadata.lastModified,
        trust,
      });
    }
    return {
      card,
      cardUrl: cardUrl.href,
      cache: cached ? "refreshed" : "miss",
      trust,
    };
  } catch (error) {
    const mapped = asA2aClientError(error, "discover");
    await emitEvidence(options.evidenceSink, {
      kind: "error",
      operation: "discover",
      url: cardUrl.href,
      details: { code: mapped.code, message: mapped.message },
    });
    throw mapped;
  }
}

export async function verifyCardTrust(
  card: AgentCard,
  trustStore: SignatureTrustStore | undefined,
): Promise<CardTrustState> {
  if (!card.signatures || card.signatures.length === 0) return "unsigned";
  if (!trustStore) {
    throw new A2aClientError(
      "SIGNATURE_VERIFICATION_FAILED",
      "Agent Card is signed but no signature trust store was configured",
      { operation: "discover" },
    );
  }
  try {
    const verifier = verifyAgentCardSignature(async (kid, jku) =>
      (await trustStore.resolve(kid, jku)) as never,
    );
    await verifier(SdkAgentCard.fromJSON(card));
    return "verified";
  } catch (error) {
    throw new A2aClientError("SIGNATURE_VERIFICATION_FAILED", "No Agent Card signature was trusted", {
      operation: "discover",
      cause: error,
    });
  }
}

export function resolveAgentCardUrl(agentUrl: string | URL, agentCardPath?: string): URL {
  let base: URL;
  try {
    base = new URL(agentUrl);
  } catch (error) {
    throw new A2aClientError("URL_POLICY_REJECTED", "Agent URL must be an absolute URL", {
      operation: "discover",
      cause: error,
    });
  }
  if (agentCardPath !== undefined) return new URL(agentCardPath, base);
  if (base.pathname.endsWith(".json")) return base;
  return new URL("/.well-known/agent-card.json", base.origin);
}

type CacheMetadata = {
  readonly expiresAt: number;
  readonly mustRevalidate: boolean;
  readonly noStore: boolean;
  readonly etag?: string;
  readonly lastModified?: string;
};

function cacheMetadata(
  headers: Headers,
  now: number,
  previous?: { readonly storedAt: number; readonly expiresAt: number; readonly etag?: string; readonly lastModified?: string },
): CacheMetadata {
  const directives = parseCacheControl(headers.get("cache-control"));
  const ageSeconds = numericHeader(headers.get("age")) ?? 0;
  const maxAgeSeconds = numericDirective(directives.get("s-maxage")) ?? numericDirective(directives.get("max-age"));
  const priorLifetime = previous ? Math.max(0, previous.expiresAt - previous.storedAt) : 0;
  const expiresHeader = headers.get("expires");
  const expiresAt = maxAgeSeconds !== undefined
    ? now + Math.max(0, maxAgeSeconds - ageSeconds) * 1000
    : expiresHeader && Number.isFinite(Date.parse(expiresHeader))
      ? Date.parse(expiresHeader)
      : now + priorLifetime;

  return {
    expiresAt,
    mustRevalidate: directives.has("no-cache") || directives.has("must-revalidate") || expiresAt <= now,
    noStore: directives.has("no-store"),
    etag: headers.get("etag") ?? previous?.etag,
    lastModified: headers.get("last-modified") ?? previous?.lastModified,
  };
}

function parseCacheControl(value: string | null): Map<string, string | true> {
  return new Map(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, rawValue] = part.split("=", 2);
        return [name.toLowerCase(), rawValue ? rawValue.replace(/^"|"$/g, "") : true];
      }),
  );
}

function numericDirective(value: string | true | undefined): number | undefined {
  return typeof value === "string" ? numericHeader(value) : undefined;
}

function numericHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}
