import { A2aClientError } from "./errors.js";
import type {
  AgentCard,
  AgentInterface,
  SupportedBinding,
  UrlPolicy,
} from "./types.js";

export type NegotiationResult = {
  readonly selectedInterface: AgentInterface & { readonly protocolBinding: SupportedBinding };
  readonly negotiatedExtensions: readonly string[];
};

export async function negotiateConnection(
  card: AgentCard,
  requestedExtensions: readonly string[],
  urlPolicy: UrlPolicy,
): Promise<NegotiationResult> {
  const declaredExtensions = card.capabilities.extensions ?? [];
  const requested = new Set(requestedExtensions);
  const missingRequired = declaredExtensions.filter((extension) => extension.required && !requested.has(extension.uri));
  if (missingRequired.length > 0) {
    throw new A2aClientError(
      "UNSUPPORTED_EXTENSION",
      `Agent requires unsupported extension(s): ${missingRequired.map((item) => item.uri).join(", ")}`,
      { operation: "discover" },
    );
  }
  const declaredUris = new Set(declaredExtensions.map((extension) => extension.uri));
  const negotiatedExtensions = [...new Set(requestedExtensions)].filter((uri) => declaredUris.has(uri));

  for (const agentInterface of card.supportedInterfaces) {
    if (!isV1ProtocolVersion(agentInterface.protocolVersion) || !isSupportedBinding(agentInterface.protocolBinding)) {
      continue;
    }
    const url = new URL(agentInterface.url);
    await urlPolicy.assertAllowed(url, { purpose: "operation" });
    return {
      selectedInterface: {
        ...agentInterface,
        protocolBinding: agentInterface.protocolBinding,
      },
      negotiatedExtensions,
    };
  }

  throw new A2aClientError(
    "UNSUPPORTED_TRANSPORT",
    "Agent Card does not declare a supported A2A v1 JSONRPC or HTTP+JSON interface",
    {
      operation: "discover",
      details: {
        interfaces: card.supportedInterfaces.map((item) => ({
          protocolBinding: item.protocolBinding,
          protocolVersion: item.protocolVersion,
        })),
      },
    },
  );
}

function isSupportedBinding(value: string): value is SupportedBinding {
  return value === "JSONRPC" || value === "HTTP+JSON";
}

function isV1ProtocolVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
  return match?.[1] === "1" && match[2] === "0";
}
