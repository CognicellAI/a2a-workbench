import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { clearM2mOAuthTokenCache, fetchM2mOAuthToken, getM2mOAuthToken, OAuthTokenError } from "@/lib/oauth";
import type { NormalizedM2mOAuth } from "@/lib/workbench-types";

let server: http.Server | undefined;

afterEach(async () => {
  clearM2mOAuthTokenCache();

  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

describe("M2M OAuth token exchange", () => {
  it("uses HTTP Basic credentials by default", async () => {
    let authorization = "";
    let body = "";

    const tokenUrl = await startTokenServer((req, res, rawBody) => {
      authorization = req.headers.authorization ?? "";
      body = rawBody;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "token-1", token_type: "Bearer", expires_in: 3600 }));
    });

    const token = await fetchM2mOAuthToken({
      ...baseOAuth(tokenUrl),
      authMethod: "client_secret_basic",
      scope: "a2a:send",
      audience: "https://agent.example.com",
    });

    expect(token).toEqual({ accessToken: "token-1", tokenType: "Bearer", expiresIn: 3600 });
    expect(authorization).toBe(`Basic ${Buffer.from("client-1:secret-1").toString("base64")}`);
    expect(new URLSearchParams(body).get("client_secret")).toBeNull();
    expect(new URLSearchParams(body).get("scope")).toBe("a2a:send");
    expect(new URLSearchParams(body).get("audience")).toBe("https://agent.example.com");
  });

  it("can send client credentials in the form body", async () => {
    let body = "";
    let authorization: string | undefined;

    const tokenUrl = await startTokenServer((req, res, rawBody) => {
      authorization = req.headers.authorization;
      body = rawBody;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "token-2" }));
    });

    const token = await fetchM2mOAuthToken({
      ...baseOAuth(tokenUrl),
      authMethod: "client_secret_post",
    });

    const params = new URLSearchParams(body);
    expect(token).toEqual({ accessToken: "token-2", tokenType: "Bearer", expiresIn: undefined });
    expect(authorization).toBeUndefined();
    expect(params.get("client_id")).toBe("client-1");
    expect(params.get("client_secret")).toBe("secret-1");
  });

  it("redacts token endpoint error details", async () => {
    const tokenUrl = await startTokenServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client", client_secret: "secret-1" }));
    });

    await expect(fetchM2mOAuthToken(baseOAuth(tokenUrl))).rejects.toMatchObject({
      name: "OAuthTokenError",
      status: 401,
      detail: { error: "invalid_client", client_secret: "[redacted]" },
    } satisfies Partial<OAuthTokenError>);
  });

  it("reuses an unexpired token for the same M2M caller", async () => {
    let requestCount = 0;

    const tokenUrl = await startTokenServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: `token-${requestCount}`, token_type: "Bearer", expires_in: 3600 }));
    });

    const first = await getM2mOAuthToken(baseOAuth(tokenUrl));
    const second = await getM2mOAuthToken(baseOAuth(tokenUrl));

    expect(requestCount).toBe(1);
    expect(first.accessToken).toBe("token-1");
    expect(second.accessToken).toBe("token-1");
  });
});

function baseOAuth(tokenUrl: string): NormalizedM2mOAuth {
  return {
    enabled: true,
    tokenUrl,
    clientId: "client-1",
    clientSecret: "secret-1",
    scope: "",
    audience: "",
    authMethod: "client_secret_basic",
  };
}

async function startTokenServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Token test server did not bind to a TCP port.");
  }

  return `http://127.0.0.1:${address.port}/oauth/token`;
}
