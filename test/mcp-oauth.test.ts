import { describe, expect, test } from "bun:test";
import { ConfigOAuthClientProvider, createOAuthMetadata } from "../src/mcp/oauth.js";
import type { McpOAuthConfig } from "../src/config/types.js";

describe("MCP OAuth config provider", () => {
  test("stores only flattened OAuth credentials", async () => {
    const oauth: McpOAuthConfig = {};
    const changes: McpOAuthConfig[] = [];
    const provider = new ConfigOAuthClientProvider(
      oauth,
      createOAuthMetadata("linear", "http://localhost/callback"),
      () => undefined,
      "http://localhost/callback",
      {
        onChange: (next) => {
          changes.push({ ...next });
        },
      },
    );

    await provider.saveClientInformation({
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uris: ["http://localhost/callback"],
    });
    await provider.saveTokens({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      scope: "mcp",
    });

    expect(oauth).toEqual({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      scope: "mcp",
      client_id: "client-id",
      client_secret: "client-secret",
    });
    expect(provider.clientInformation()).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      client_id_issued_at: undefined,
      client_secret_expires_at: undefined,
    });
    expect(provider.tokens()).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });
    expect(changes).toHaveLength(2);
  });

  test("supports access-token-only OAuth responses", async () => {
    const oauth: McpOAuthConfig = {};
    const provider = new ConfigOAuthClientProvider(
      oauth,
      createOAuthMetadata("openbnb", "http://localhost/callback"),
      () => undefined,
      "http://localhost/callback",
    );

    await provider.saveTokens({
      access_token: "access-token",
      token_type: "Bearer",
    });

    expect(oauth).toEqual({
      access_token: "access-token",
      token_type: "Bearer",
    });
    expect(provider.tokens()).toEqual({
      access_token: "access-token",
      token_type: "Bearer",
      refresh_token: undefined,
      id_token: undefined,
      expires_in: undefined,
      scope: undefined,
    });
  });

  test("does not persist empty optional OAuth fields", async () => {
    const oauth: McpOAuthConfig = {};
    const provider = new ConfigOAuthClientProvider(
      oauth,
      createOAuthMetadata("openbnb", "http://localhost/callback"),
      () => undefined,
      "http://localhost/callback",
    );

    await provider.saveClientInformation({
      client_id: "client-id",
      client_secret: "",
      redirect_uris: ["http://localhost/callback"],
    });
    await provider.saveTokens({
      access_token: "access-token",
      token_type: "Bearer",
      refresh_token: "",
      scope: "",
    });

    expect(oauth).toEqual({
      access_token: "access-token",
      token_type: "Bearer",
      client_id: "client-id",
    });
  });
});
