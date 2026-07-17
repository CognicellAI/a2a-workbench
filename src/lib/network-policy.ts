import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { A2aClientError, type UrlPolicy, type UrlPolicyContext } from "@a2a-workbench/client";
import { ConnectionError } from "@/lib/connection";

const RESERVED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

export class WorkbenchUrlPolicy implements UrlPolicy {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  async assertAllowed(url: URL, context: UrlPolicyContext): Promise<void> {
    try {
      await assertSafeUpstreamUrl(url.href, this.#env);
    } catch (error) {
      if (error instanceof A2aClientError) throw error;
      throw new A2aClientError(
        "URL_POLICY_REJECTED",
        error instanceof Error ? error.message : "Workbench URL policy rejected the target.",
        {
          operation: context.purpose === "discovery" ? "discover" : "sendMessage",
          cause: error,
          details: { purpose: context.purpose },
        },
      );
    }
  }
}

export async function assertSafeUpstreamUrl(
  urlString: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const url = new URL(urlString);
  const allowlist = readAllowlist(env.A2A_UPSTREAM_ALLOWLIST);
  const hostname = normalizeHostname(url.hostname);

  if (allowlist.length > 0 && !matchesAllowlist(hostname, allowlist)) {
    throw new ConnectionError("A2A upstream host is not in A2A_UPSTREAM_ALLOWLIST.");
  }

  const privateNetworksAllowed = env.A2A_ALLOW_PRIVATE_NETWORKS === "true";
  if (url.protocol !== "https:") {
    if (!(url.protocol === "http:" && privateNetworksAllowed && isLocalDevelopmentHost(hostname))) {
      throw new ConnectionError("A2A strict mode requires HTTPS except for explicit local development.");
    }
  }

  if (privateNetworksAllowed) {
    return;
  }

  if (RESERVED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
  }

  const ipFamily = isIP(hostname);
  if (ipFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ConnectionError("A2A upstream hostname could not be resolved.");
  }

  if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedIp(address.address))) {
    throw new ConnectionError("A2A upstream host resolves to a private or reserved network.");
  }
}

function readAllowlist(value: string | undefined): string[] {
  return value?.split(",").map((entry) => normalizeAllowlistEntry(entry.trim())).filter(Boolean) ?? [];
}

function normalizeAllowlistEntry(entry: string): string {
  if (!entry) return "";
  try {
    return normalizeHostname(new URL(entry).hostname);
  } catch {
    return normalizeHostname(entry);
  }
}

function matchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
    }
    if (entry.startsWith(".")) {
      const root = entry.slice(1);
      return hostname === root || hostname.endsWith(entry);
    }
    return hostname === entry;
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return RESERVED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    isPrivateOrReservedIp(hostname);
}

function isPrivateOrReservedIp(ip: string): boolean {
  const mappedIpv4 = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) return isPrivateOrReservedIpv4(mappedIpv4);
  return isIP(ip) === 4 ? isPrivateOrReservedIpv4(ip) : isPrivateOrReservedIpv6(ip);
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) || first >= 224;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8");
}
