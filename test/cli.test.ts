import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../src/cli.js";
import { YamlConfigRepository } from "../src/config/repository.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ai-fed-"));
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
    const config = await repository.read(join(cwd, ".mcp-federation.yml"));

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
    const config = await repository.read(join(cwd, ".mcp-federation.yml"));

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
    const config = await repository.read(join(cwd, ".mcp-federation.yml"));

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
        join(cwd, ".mcp-federation.yml"),
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
});
