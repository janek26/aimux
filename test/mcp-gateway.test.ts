import { describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { applyMethodControls, createMcpHttpHandler, listMcpMethodNames, McpAuthError, McpMux, validateMcpServerConfig, type McpClientPort } from "../src/mcp/gateway.js";
import type { McpServerConfig } from "../src/config/types.js";

const fakeClient = (toolNames: string[]): McpClientPort => ({
  listTools: async () => ({
    tools: toolNames.map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
  }),
  callTool: async ({ name }) => ({
    content: [{ type: "text", text: `called:${name}` }],
  }),
  listPrompts: async () => ({ prompts: [] }),
  getPrompt: async () => ({ messages: [] }),
  listResources: async () => ({ resources: [] }),
  readResource: async () => ({ contents: [] }),
  close: async () => undefined,
});

describe("MCP gateway", () => {
  test("applies whitelist, blacklist and renames before exposing methods", () => {
    const controls: McpServerConfig = {
      transport: "http",
      url: "https://mcp.example",
      method_whitelist: ["search"],
      method_renames: {
        search: "hf_search",
      },
    };

    expect(
      applyMethodControls("hf", controls, [
        { name: "search" },
        { name: "delete" },
      ]).map((item) => [item.originalName, item.exposedName]),
    ).toEqual([["search", "hf_search"]]);
  });

  test("forwards muxed tool calls back to the owning server", async () => {
    const mux = new McpMux({
      a: {
        config: {
          transport: "http",
          url: "https://a.example",
          method_renames: { search: "a_search" },
        },
        client: fakeClient(["search"]),
      },
      b: {
        config: {
          transport: "http",
          url: "https://b.example",
        },
        client: fakeClient(["search"]),
      },
    });

    await expect(mux.listTools()).resolves.toMatchObject({
      tools: [{ name: "a_search" }, { name: "search" }],
    });
    await expect(mux.callTool("a_search")).resolves.toMatchObject({
      content: [{ text: "called:search" }],
    });
  });

  test("fails validation with a clear auth error when auth is not fully set up", async () => {
    await expect(
      validateMcpServerConfig(
        "private",
        { transport: "http", url: "https://mcp.example" },
        async () => {
          throw new UnauthorizedError("No auth provider");
        },
      ),
    ).rejects.toBeInstanceOf(McpAuthError);
  });

  test("validates method controls after an authenticated connection succeeds", async () => {
    await expect(
      validateMcpServerConfig(
        "private",
        {
          transport: "http",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer token" },
          method_whitelist: ["echo"],
        },
        async () => fakeClient(["echo"]),
      ),
    ).resolves.toBeUndefined();
  });

  test("lists available tools and prompts for interactive method controls", async () => {
    const client: McpClientPort = {
      ...fakeClient(["search", "echo"]),
      listPrompts: async () => ({ prompts: [{ name: "summarize" }] }),
    };

    await expect(
      listMcpMethodNames(
        "private",
        {
          transport: "http",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer token" },
        },
        async () => client,
      ),
    ).resolves.toEqual(["echo", "search", "summarize"]);
  });

  test("retries MCP HTTP mux creation after an initialization failure", async () => {
    let attempts = 0;
    const handler = createMcpHttpHandler(
      {
        mcp: {
          flaky: {
            transport: "http",
            url: "https://mcp.example",
          },
        },
      },
      {},
      async () => {
        attempts += 1;
        throw new Error("temporary failure");
      },
    );
    const request = new Request("http://localhost/mcp", { method: "POST" });

    await expect(handler(request)).rejects.toThrow("temporary failure");
    await expect(handler(request)).rejects.toThrow("temporary failure");
    expect(attempts).toBe(2);
  });
});
