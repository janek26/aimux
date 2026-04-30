import { describe, expect, test } from "bun:test";
import {
  addLlmProvider,
  addMcpServer,
  createDefaultConfig,
  listLlmProviders,
  removeLlmProvider,
  removeMcpServer,
} from "../src/core/config.js";

describe("config core", () => {
  test("adds mapped and fallback LLM providers while enforcing global names", () => {
    const config = addLlmProvider(
      createDefaultConfig(),
      "custom/prod",
      "prod",
      {
        preset: "openai",
      },
      {
        model: "gpt-5",
      },
    );

    expect(listLlmProviders(config).map(({ target, providerName }) => [target, providerName])).toEqual([
      ["custom/prod", "prod"],
    ]);
    expect(() =>
      addLlmProvider(config, "fallback", "prod", {
        preset: "openai",
      }),
    ).toThrow("already exists");
  });

  test("removes LLM providers by unique provider name", () => {
    const config = addLlmProvider(createDefaultConfig(), "fallback", "openai-prod", {
      preset: "openai",
    });
    const result = removeLlmProvider(config, "openai-prod");

    expect(result.removed).toBe(true);
    expect(listLlmProviders(result.config)).toEqual([]);
  });

  test("adds and removes MCP servers by name", () => {
    const config = addMcpServer(createDefaultConfig(), "github", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });

    expect(config.mcp?.github?.transport).toBe("stdio");
    expect(removeMcpServer(config, "github").removed).toBe(true);
  });
});
