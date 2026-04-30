import { beforeAll, describe, expect, test } from "bun:test";
import { registerSchema, validate } from "@hyperjump/json-schema/draft-2020-12";
import type { SchemaObject } from "@hyperjump/json-schema/draft-2020-12";
import type { Json } from "@hyperjump/json-pointer";

type ConfigSchema = SchemaObject & { $id: string };
type ValidateConfig = Awaited<ReturnType<typeof validate>>;

let validateConfig: ValidateConfig;

beforeAll(async () => {
  const configSchema = (await Bun.file(
    new URL("../src/config/config.schema.json", import.meta.url),
  ).json()) as ConfigSchema;

  registerSchema(configSchema);
  validateConfig = await validate(configSchema.$id);
});

const expectValid = async (config: Json) => {
  const result = validateConfig(config);

  expect(result.valid).toBe(true);
};

const expectInvalid = async (config: Json) => {
  const result = validateConfig(config);

  expect(result.valid).toBe(false);
};

describe("config schema", () => {
  test("accepts the complete target config shape", async () => {
    await expectValid({
      providers: {
        "added-provider": {
          preset: "openai",
          token: "apikey",
        },
        "added-provider-2": {
          preset: "openai",
          token: "apikey",
        },
        "custom-provider": {
          schema: "openai",
          url: "https://llm.example.com/v1",
          token: "apikey",
        },
      },
      llm: {
        "custom/prod": {
          provider: "added-provider",
          model: "gpt5",
        },
        fallback: [
          {
            provider: "added-provider-2",
          },
          {
            provider: "custom-provider",
            model_whitelist: ["deepseek-v4"],
          },
        ],
      },
      mcp: {
        "hugging-face": {
          transport: "http",
          url: "https://huggingface.co/mcp",
          headers: {
            Authorization: "Bearer hf_token",
          },
          method_whitelist: ["model_search"],
          method_renames: {
            model_search: "hf_model_search",
          },
        },
        linear: {
          transport: "sse",
          url: "https://mcp.linear.app/sse",
          headers: {
            Authorization: "Bearer linear_token",
          },
        },
        github: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token",
          },
        },
        "local-files": {
          transport: "stdio",
          command: "mcp-server-filesystem",
          args: ["."],
          method_blacklist: ["delete_file"],
        },
      },
    });
  });

  test("accepts an http MCP in the Claude Code CLI shape", async () => {
    await expectValid({
      mcp: {
        "hugging-face": {
          transport: "http",
          url: "https://huggingface.co/mcp",
        },
      },
    });
  });

  test("accepts only minimal persisted MCP OAuth credentials", async () => {
    await expectValid({
      mcp: {
        linear: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          oauth: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            client_id: "client-id",
          },
        },
      },
    });

    await expectValid({
      mcp: {
        openbnb: {
          transport: "http",
          url: "https://mcp.openbnb.ai/mcp",
          oauth: {
            access_token: "access-token",
            token_type: "Bearer",
          },
        },
      },
    });

    await expectInvalid({
      mcp: {
        linear: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          oauth: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
          },
        },
      },
    });

    await expectInvalid({
      mcp: {
        linear: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          oauth: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            client_id: "client-id",
            tokens: {},
            clientInformation: {},
            discoveryState: {},
            codeVerifier: "verifier",
            redirectUrl: "http://localhost:1234/callback",
          },
        },
      },
    });

    await expectInvalid({
      mcp: {
        linear: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          oauth: {},
        },
      },
    });
  });

  test("accepts common LLM presets", async () => {
    await expectValid({
      providers: {
        "openrouter-provider": {
          preset: "openrouter",
          token: "openrouter_key",
        },
        "fireworks-provider": {
          preset: "fireworks",
          token: "fireworks_key",
        },
      },
      llm: {
        fallback: [
          {
            provider: "openrouter-provider",
          },
          {
            provider: "fireworks-provider",
          },
        ],
      },
    });
  });

  test("accepts an initialized config before providers are added", async () => {
    await expectValid({});
  });

  test("rejects stdio MCP servers without a command", async () => {
    await expectInvalid({
      mcp: {
        github: {
          transport: "stdio",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    });
  });

  test("rejects remote MCP servers without a url", async () => {
    await expectInvalid({
      mcp: {
        "hugging-face": {
          transport: "http",
        },
      },
    });
  });

  test("rejects MCP method whitelist and blacklist together", async () => {
    await expectInvalid({
      mcp: {
        "local-files": {
          transport: "stdio",
          command: "mcp-server-filesystem",
          method_whitelist: ["read_file"],
          method_blacklist: ["delete_file"],
        },
      },
    });
  });

  test("rejects LLM providers with preset and schema together", async () => {
    await expectInvalid({
      providers: {
        "custom-provider": {
          preset: "openai",
          schema: "openai",
          url: "https://llm.example.com/v1",
        },
      },
    });
  });

  test("rejects LLM model whitelist and blacklist together", async () => {
    await expectInvalid({
      providers: {
        "added-provider": {
          preset: "openai",
        },
      },
      llm: {
        fallback: [
          {
            provider: "added-provider",
            model_whitelist: ["gpt-5"],
            model_blacklist: ["gpt-4"],
          },
        ],
      },
    });
  });

  test("rejects custom LLM routes without an upstream model", async () => {
    await expectInvalid({
      providers: {
        prod: {
          preset: "openai",
        },
      },
      llm: {
        "custom/prod": {
          provider: "prod",
        },
      },
    });
  });
});
