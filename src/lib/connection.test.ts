import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  normalizeConnection,
  redactM2mOAuth,
  redactHeaders,
  toPersistableConnection,
} from "@/lib/connection";

describe("connection normalization", () => {
  it("rejects missing and non-http upstream URLs", () => {
    expect(() => normalizeConnection(undefined, {})).toThrow(ConnectionError);
    expect(() => normalizeConnection({ upstream: "file:///tmp/a2a" }, {})).toThrow("http or https");
  });

  it("merges default and UI headers case-insensitively with UI precedence", () => {
    const connection = normalizeConnection(
      {
        upstream: "https://agent.example.com/a2a",
        headers: [
          { name: "APIKEY", value: "ui-secret", enabled: true, secret: true },
          { name: "X-Trace", value: "trace-1", enabled: true },
          { name: "Bad Header", value: "ignored", enabled: true },
        ],
      },
      {
        A2A_API_KEY: "env-secret",
        A2A_SCOPE_USER: "operator-1",
      },
    );

    expect(connection.headers).toEqual([
      { name: "APIKEY", value: "ui-secret", enabled: true, secret: true },
      { name: "X-A2A-Scope-User", value: "operator-1", enabled: true, secret: false },
      { name: "X-Trace", value: "trace-1", enabled: true, secret: false },
    ]);
  });

  it("redacts secret headers for client-visible metadata", () => {
    const connection = normalizeConnection(
      {
        upstream: "https://agent.example.com/a2a",
        headers: [{ name: "Authorization", value: "Bearer abc", enabled: true }],
      },
      {},
    );

    expect(redactHeaders(connection.headers)).toEqual({
      Authorization: "[redacted]",
    });
  });

  it("persists safe connection preferences but never headers or OAuth credentials", () => {
    expect(
      toPersistableConnection({
        upstream: "https://agent.example.com/a2a",
        mode: "strict",
        binding: "HTTP+JSON",
        a2uiTrigger: "[a2ui]",
        headers: [
          { name: "Authorization", value: "Bearer abc", enabled: true, secret: true },
          { name: "X-Trace", value: "trace-1", enabled: true, secret: false },
        ],
        oauth: {
          enabled: false,
          tokenUrl: "",
          clientId: "",
          clientSecret: "",
          scope: "",
          audience: "",
          authMethod: "client_secret_basic",
        },
      }),
    ).toEqual({
      upstream: "https://agent.example.com/a2a",
      mode: "strict",
      binding: "HTTP+JSON",
      a2uiTrigger: "[a2ui]",
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
    });
  });

  it("normalizes M2M OAuth credentials when enabled", () => {
    const connection = normalizeConnection(
      {
        upstream: "https://agent.example.com/a2a",
        oauth: {
          enabled: true,
          tokenUrl: "https://issuer.example.com/oauth/token",
          clientId: "client-1",
          clientSecret: "secret-1",
          scope: "a2a:send",
          audience: "https://agent.example.com",
          authMethod: "client_secret_post",
        },
      },
      {},
    );

    expect(connection.oauth).toEqual({
      enabled: true,
      tokenUrl: "https://issuer.example.com/oauth/token",
      clientId: "client-1",
      clientSecret: "secret-1",
      scope: "a2a:send",
      audience: "https://agent.example.com",
      authMethod: "client_secret_post",
    });
  });

  it("redacts and does not persist M2M OAuth credentials", () => {
    const oauth = {
      enabled: true,
      tokenUrl: "https://issuer.example.com/oauth/token",
      clientId: "client-1",
      clientSecret: "secret-1",
      scope: "",
      audience: "",
      authMethod: "client_secret_basic" as const,
    };

    expect(redactM2mOAuth(oauth)).toEqual({
      ...oauth,
      clientSecret: "[redacted]",
    });
    expect(toPersistableConnection({
      upstream: "https://agent.example.com/a2a",
      mode: "strict",
      binding: "HTTP+JSON",
      a2uiTrigger: "[a2ui]",
      headers: [],
      oauth,
    }).oauth).toEqual({
      enabled: false,
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
      scope: "",
      audience: "",
      authMethod: "client_secret_basic",
    });
  });

  it("requires OAuth fields only when enabled", () => {
    expect(
      normalizeConnection(
        {
          upstream: "https://agent.example.com/a2a",
          oauth: { enabled: false },
        },
        {},
      ).oauth,
    ).toBeUndefined();
    expect(() =>
      normalizeConnection(
        {
          upstream: "https://agent.example.com/a2a",
          oauth: { enabled: true, tokenUrl: "https://issuer.example.com/oauth/token" },
        },
        {},
      ),
    ).toThrow("Missing OAuth client ID");
  });
});
