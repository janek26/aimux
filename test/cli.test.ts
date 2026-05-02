import { afterEach, describe, expect, test } from "bun:test";
import { parse as parseJsonc } from "jsonc-parser";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeJsoncObjectContent, mergeZedGlobalSettingsContent, parseArgs, runCli } from "../src/cli.js";
import { YamlConfigRepository } from "../src/config/repository.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aimux-"));
  tempDirs.push(dir);
  return dir;
};

const writeFakeMcpServer = async (cwd: string): Promise<string> => {
  const fakeMcpPath = join(cwd, "fake-mcp-server.ts");
  const serverImport = join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js");
  const stdioImport = join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
  const typesImport = join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js");

  await Bun.write(
    fakeMcpPath,
    `
import { Server } from ${JSON.stringify(serverImport)};
import { StdioServerTransport } from ${JSON.stringify(stdioImport)};
import { ListToolsRequestSchema } from ${JSON.stringify(typesImport)};

const server = new Server(
  { name: "fake-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await server.close().catch(() => undefined);
  process.exit(0);
};

process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", inputSchema: { type: "object" } }],
}));

await server.connect(new StdioServerTransport());
await new Promise(() => undefined);
`,
  );

  return fakeMcpPath;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI", () => {
  test("parses flag values without treating them as command words", () => {
    expect(parseArgs(["llm", "add", "fallback", "--name", "prod", "--preset=openai"])).toEqual({
      command: ["llm", "add", "fallback"],
      flags: {
        name: "prod",
        preset: "openai",
      },
    });
  });

  test("initializes and edits a config through flag-driven commands", async () => {
    const cwd = await createTempDir();
    const fakeMcpPath = await writeFakeMcpServer(cwd);
    const llm = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ data: [{ id: "gpt-4o" }] }),
    });
    const outputs: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (message: string) => outputs.push(message),
      stderr: (message: string) => errors.push(message),
    };

    try {
      expect(await runCli(["init"], context)).toBe(0);
      expect(
        await runCli(
          ["llm", "add", "fallback", "--name", "prod", "--schema", "openai", "--url", `http://127.0.0.1:${llm.port}/v1`],
          context,
        ),
      ).toBe(0);
      expect(await runCli(["llm", "add", "custom/prod", "--name", "prod", "--model", "gpt-4o"], context)).toBe(0);
      expect(
        await runCli(
          ["mcp", "add", "fake", "--transport", "stdio", "--command", "bun", "--args", fakeMcpPath],
          context,
        ),
      ).toBe(0);
    } finally {
      llm.stop(true);
    }

    const repository = new YamlConfigRepository(undefined, cwd);
    const config = await repository.read(join(cwd, ".aimux.yml"));

    expect(errors).toEqual([]);
    expect(Object.keys(config?.config.providers ?? {})).toEqual(["prod"]);
    expect(Object.keys(config?.config.llm ?? {})).toEqual(["custom/prod", "fallback"]);
    expect(config?.config.llm?.fallback?.map((route) => route.provider)).toEqual(["prod"]);
    expect(config?.config.llm?.["custom/prod"]).toEqual({ provider: "prod", model: "gpt-4o" });
    expect(config?.config.mcp?.fake?.transport).toBe("stdio");
  });

  test("requires upstream model when adding a custom LLM target", async () => {
    const cwd = await createTempDir();
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: (message: string) => errors.push(message),
    };

    expect(await runCli(["init"], context)).toBe(0);
    expect(await runCli(["llm", "add", "custom/prod", "--name", "prod", "--preset", "openai"], context)).toBe(1);
    expect(errors).toContain("Custom LLM targets require --model <upstream-model>");
  });

  test("does not edit config when LLM preflight rejects a model", async () => {
    const cwd = await createTempDir();
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: (message: string) => errors.push(message),
    };
    const llm = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ data: [{ id: "known-model" }] }),
    });

    try {
      expect(await runCli(["init"], context)).toBe(0);
      expect(
        await runCli(
          [
            "llm",
            "add",
            "custom/prod",
            "--name",
            "prod",
            "--schema",
            "openai",
            "--url",
            `http://127.0.0.1:${llm.port}/v1`,
            "--model",
            "missing-model",
          ],
          context,
        ),
      ).toBe(1);
    } finally {
      llm.stop(true);
    }

    const repository = new YamlConfigRepository(undefined, cwd);
    const config = await repository.read(join(cwd, ".aimux.yml"));

    expect(errors.at(-1)).toContain("does not expose model: missing-model");
    expect(config?.config).toEqual({});
  });

  test("does not edit config when MCP preflight rejects method controls", async () => {
    const cwd = await createTempDir();
    const fakeMcpPath = await writeFakeMcpServer(cwd);
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: (message: string) => errors.push(message),
    };

    expect(await runCli(["init"], context)).toBe(0);
    expect(
      await runCli(
        [
          "mcp",
          "add",
          "fake",
          "--transport",
          "stdio",
          "--command",
          "bun",
          "--args",
          fakeMcpPath,
          "--method-whitelist",
          "missing",
        ],
        context,
      ),
    ).toBe(1);

    const repository = new YamlConfigRepository(undefined, cwd);
    const config = await repository.read(join(cwd, ".aimux.yml"));

    expect(errors.at(-1)).toContain("does not expose method(s): missing");
    expect(config?.config).toEqual({});
  });

  test("setup aliases full config validation with live preflight checks", async () => {
    const cwd = await createTempDir();
    const fakeMcpPath = await writeFakeMcpServer(cwd);
    const llm = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ data: [{ id: "gpt-4o" }] }),
    });
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: () => undefined,
    };

    try {
      await Bun.write(
        join(cwd, ".aimux.yml"),
        `providers:
  prod:
    schema: openai
    url: http://127.0.0.1:${llm.port}/v1
llm:
  custom/prod:
    provider: prod
    model: gpt-4o
mcp:
  fake:
    transport: stdio
    command: bun
    args: ["${fakeMcpPath}"]
`,
      );

      expect(await runCli(["setup"], context)).toBe(0);
      expect(await runCli(["config", "validate"], context)).toBe(0);
    } finally {
      llm.stop(true);
    }
  });

  test("generates tool configs for common AI clients in the current directory", async () => {
    const cwd = await createTempDir();
    const outputs: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (message: string) => outputs.push(message),
      stderr: (message: string) => errors.push(message),
    };

    await Bun.write(
      join(cwd, ".aimux.yml"),
      `providers:
  prod:
    schema: openai
    url: http://127.0.0.1:11434/v1
llm:
  custom/prod:
    provider: prod
    model: upstream-model
  fallback:
    - provider: prod
      model_whitelist: ["fallback-model"]
mcp:
  fake:
    transport: http
    url: http://127.0.0.1:3333/mcp
`,
    );
    await Bun.write(
      join(cwd, "opencode.json"),
      JSON.stringify({ provider: { existing: { name: "Existing" } } }),
    );
    await Bun.write(
      join(cwd, ".zed/settings.json"),
      `// Existing Zed JSONC settings
{
  "language_models": {
    "openai_compatible": {
      "Existing": {
        "api_url": "http://localhost:1234/v1",
      },
    },
  },
}
`,
    );

    expect(await runCli(["generate", "all", "--port", "9999"], context)).toBe(0);

    const opencode = await Bun.file(join(cwd, "opencode.json")).json();
    const cursor = await Bun.file(join(cwd, ".cursor/mcp.json")).json();
    const zed = parseJsonc(await Bun.file(join(cwd, ".zed/settings.json")).text());
    const claudeCode = await Bun.file(join(cwd, ".mcp.json")).json();
    const codex = await Bun.file(join(cwd, ".codex/config.toml")).text();
    const gemini = await Bun.file(join(cwd, ".gemini/settings.json")).json();

    expect(opencode.provider.existing.name).toBe("Existing");
    expect(opencode.model).toBe("aimux/custom/prod");
    expect(opencode.provider["aimux"].options.baseURL).toBe("http://localhost:9999/v1");
    expect(Object.keys(opencode.provider["aimux"].models)).toEqual(["custom/prod", "fallback-model"]);
    expect(opencode.mcp["aimux"].url).toBe("http://localhost:9999/mcp");
    expect(cursor).toEqual({
      mcpServers: {
        "aimux": {
          url: "http://localhost:9999/mcp",
        },
      },
    });
    expect(zed.language_models.openai_compatible.Existing.api_url).toBe("http://localhost:1234/v1");
    expect(zed.language_models.openai_compatible["AIMux"]).toBeUndefined();
    expect(zed.context_servers["aimux"].args).toEqual(["serve", "mcp"]);
    expect(claudeCode.mcpServers["aimux"]).toEqual({
      type: "http",
      url: "http://localhost:9999/mcp",
    });
    expect(codex).toContain("# <aimux-generated>");
    expect(codex).toContain('model = "custom/prod"');
    expect(codex).toContain('[model_providers.aimux]');
    expect(codex).toContain('base_url = "http://localhost:9999/v1"');
    expect(codex).toContain('[mcp_servers.aimux]');
    expect(codex).toContain('url = "http://localhost:9999/mcp"');
    expect(gemini.mcpServers["aimux"]).toEqual({
      httpUrl: "http://localhost:9999/mcp",
      timeout: 300000,
      trust: true,
    });
    expect(outputs).toContain(`Generated ${join(cwd, "opencode.json")}`);
    expect(outputs).toContain(`Generated ${join(cwd, ".cursor/mcp.json")}`);
    expect(outputs).toContain(`Generated ${join(cwd, ".zed/settings.json")}`);
    expect(outputs).toContain(`Generated ${join(cwd, ".mcp.json")}`);
    expect(outputs).toContain(`Generated ${join(cwd, ".codex/config.toml")}`);
    expect(outputs).toContain(`Generated ${join(cwd, ".gemini/settings.json")}`);
    expect(errors).toContain("cursor: LLM endpoint config is not supported by project-local generation; wrote MCP config only.");
    expect(errors).toContain("claude-code: LLM endpoint config is not supported by project-local generation; wrote MCP config only.");
    expect(errors).toContain("gemini-cli: LLM endpoint config is not supported by project-local generation; wrote MCP config only.");
    expect(errors).toContain(
      "zed: language_models is only supported in global Zed settings; wrote local MCP config only. Run interactively to approve updating global Zed settings.",
    );
  });

  test("rejects unsupported generate targets", async () => {
    const cwd = await createTempDir();
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: (message: string) => errors.push(message),
    };

    await Bun.write(join(cwd, ".aimux.yml"), "");

    expect(await runCli(["generate", "unknown"], context)).toBe(1);
    expect(errors.at(-1)).toContain("Unsupported generate target(s): unknown");
  });

  test("requires generate targets when not running interactively", async () => {
    const cwd = await createTempDir();
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: () => undefined,
      stderr: (message: string) => errors.push(message),
    };

    await Bun.write(join(cwd, ".aimux.yml"), "");

    expect(await runCli(["generate"], context)).toBe(1);
    expect(errors.at(-1)).toContain("Missing tool name");
  });

  test("warns when only MCP can be generated for a model-capable tool", async () => {
    const cwd = await createTempDir();
    const outputs: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (message: string) => outputs.push(message),
      stderr: (message: string) => errors.push(message),
    };

    await Bun.write(
      join(cwd, ".aimux.yml"),
      `mcp:
  fake:
    transport: http
    url: http://127.0.0.1:3333/mcp
`,
    );

    expect(await runCli(["generate", "opencode"], context)).toBe(0);

    const opencode = await Bun.file(join(cwd, "opencode.json")).json();
    expect(opencode.provider).toEqual({});
    expect(opencode.mcp["aimux"].url).toBe("http://localhost:8787/mcp");
    expect(outputs).toContain(`Generated ${join(cwd, "opencode.json")}`);
    expect(errors).toContain("opencode: no concrete LLM models found in config; wrote MCP config and skipped LLM model entries.");
  });

  test("merges local Zed JSONC without touching language model settings", () => {
    const content = `// Existing Zed JSONC settings
{
  "language_models": {
    "openai_compatible": {
      "Existing": {
        "api_url": "http://localhost:1234/v1",
      },
    },
  },
}
`;

    const merged = mergeJsoncObjectContent(".zed/settings.json", content, {
      context_servers: {
        "aimux": {
          command: "aimux",
          args: ["serve", "mcp"],
        },
      },
    });
    const parsed = parseJsonc(merged);

    expect(merged).toContain("// Existing Zed JSONC settings");
    expect(parsed.language_models.openai_compatible.Existing.api_url).toBe("http://localhost:1234/v1");
    expect(parsed.language_models.openai_compatible["AIMux"]).toBeUndefined();
    expect(parsed.context_servers["aimux"].args).toEqual(["serve", "mcp"]);
  });

  test("merges global Zed language models and agent defaults without replacing other settings", () => {
    const content = `// Zed settings
{
  "agent": {
    "inline_assistant_model": {
      "provider": "Fireworks",
      "model": "accounts/fireworks/models/kimi",
      "enable_thinking": false,
    },
    "default_model": {
      "provider": "Fireworks",
      "model": "accounts/fireworks/models/kimi",
      "enable_thinking": false,
    },
    "favorite_models": [],
    "model_parameters": [],
  },
  "language_models": {
    "openai_compatible": {
      "Fireworks": {
        "api_url": "https://api.fireworks.ai/inference/v1",
        "available_models": [
          {
            "name": "accounts/fireworks/models/kimi",
          },
        ],
      },
      "AIMux": {
        "api_url": "http://localhost:8787/v1",
        "available_models": [
          {
            "name": "old-model",
          },
        ],
      },
    },
  },
}
`;

    const merged = mergeZedGlobalSettingsContent(
      "/Users/example/.config/zed/settings.json",
      content,
      ["custom/prod"],
      9999,
    );
    const parsed = parseJsonc(merged);

    expect(merged).toContain("// Zed settings");
    expect(parsed.agent.favorite_models).toEqual([]);
    expect(parsed.agent.model_parameters).toEqual([]);
    expect(parsed.agent.default_model).toEqual({
      provider: "AIMux",
      model: "custom/prod",
      enable_thinking: false,
    });
    expect(parsed.agent.inline_assistant_model).toEqual({
      provider: "AIMux",
      model: "custom/prod",
      enable_thinking: false,
    });
    expect(parsed.language_models.openai_compatible.Fireworks.api_url).toBe("https://api.fireworks.ai/inference/v1");
    expect(parsed.language_models.openai_compatible["AIMux"].api_url).toBe("http://localhost:9999/v1");
    expect(parsed.language_models.openai_compatible["AIMux"].available_models.map((model: { name: string }) => model.name))
      .toEqual(["custom/prod"]);
  });
});
