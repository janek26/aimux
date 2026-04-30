import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const projectRoot = new URL("..", import.meta.url).pathname;
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

const testEnv = (home: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(Bun.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .concat([
        ["HOME", home],
        ["NO_COLOR", "1"],
      ]),
  );

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ai-fed-e2e-"));
  tempDirs.push(dir);
  return dir;
};

const availablePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address === "object" && address) {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }

      server.close(() => reject(new Error("Could not allocate a port")));
    });
  });

const runCli = async (cwd: string, args: string[]): Promise<CliResult> => {
  const process = Bun.spawn({
    cmd: ["bun", cliPath, ...args],
    cwd,
    env: testEnv(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const expectCliOk = async (cwd: string, args: string[]): Promise<CliResult> => {
  const result = await runCli(cwd, args);

  expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  return result;
};

const waitForHttp = async (url: string, process: Bun.Subprocess): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if ((await Promise.race([process.exited, Promise.resolve(undefined)])) !== undefined) {
      throw new Error(`Process exited before ${url} became reachable`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the server binds the port.
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${url}`);
};

const stopProcess = async (process: Bun.Subprocess): Promise<void> => {
  process.kill();
  await Promise.race([process.exited, Bun.sleep(1_000)]);
};

const readOutputChunk = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const result = await Promise.race([reader.read(), Bun.sleep(1_000).then(() => undefined)]);
  reader.releaseLock();

  return result?.value ? new TextDecoder().decode(result.value) : "";
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
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesImport)};

const server = new Server(
  { name: "fake-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes a message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
    {
      name: "dangerous",
      description: "Should be hidden by ai-fed",
      inputSchema: { type: "object" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: \`fake:\${request.params.arguments?.message ?? ""}\`,
    },
  ],
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

describe("CLI e2e", () => {
  test("manages config and serves an OpenAI-compatible LLM gateway through the CLI", async () => {
    const cwd = await createTempDir();
    const upstreamPort = await availablePort();
    const gatewayPort = await availablePort();
    const chatRequests: unknown[] = [];
    const upstream = Bun.serve({
      port: upstreamPort,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "target-model" }] });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = await request.json();
          chatRequests.push(body);
          return Response.json({
            id: "fake-chat",
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "from fake llm" } }],
          });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      await expectCliOk(cwd, ["init"]);
      await expectCliOk(cwd, [
        "llm",
        "add",
        "custom/prod",
        "--name",
        "fake-direct",
        "--schema",
        "openai",
        "--url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "target-model",
      ]);
      await expectCliOk(cwd, [
        "llm",
        "add",
        "fallback",
        "--name",
        "fake-fallback",
        "--schema",
        "openai",
        "--url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model-whitelist",
        "target-model",
      ]);

      const listResult = await expectCliOk(cwd, ["llm", "list"]);
      expect(listResult.stdout).toContain("custom/prod\tfake-direct\topenai");
      expect(listResult.stdout).toContain("fallback\tfake-fallback\topenai");

      const gateway = Bun.spawn({
        cmd: ["bun", cliPath, "serve", "llm", "--port", String(gatewayPort)],
        cwd,
        env: testEnv(cwd),
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        await waitForHttp(`http://127.0.0.1:${gatewayPort}/v1/models`, gateway);

        const models = (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`).then((response) =>
          response.json(),
        )) as { data: Array<{ id: string }> };
        expect(models.data.map((model) => model.id)).toContain("custom/prod");
        expect(models.data.map((model) => model.id)).toContain("target-model");

        const directChat = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "custom/prod",
            messages: [{ role: "user", content: "hello" }],
          }),
        }).then((response) => response.json() as Promise<{ choices: Array<{ message: { content: string } }> }>);
        expect(directChat.choices[0]?.message.content).toBe("from fake llm");
        expect(chatRequests).toContainEqual(
          expect.objectContaining({
            model: "target-model",
          }),
        );
      } finally {
        await stopProcess(gateway);
      }
    } finally {
      upstream.stop(true);
    }
  }, 15_000);

  test("serves LLM and MCP together over HTTP by default", async () => {
    const cwd = await createTempDir();
    const fakeMcpPath = await writeFakeMcpServer(cwd);
    const upstreamPort = await availablePort();
    const servePort = await availablePort();
    const upstream = Bun.serve({
      port: upstreamPort,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "target-model" }] });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = await request.json();
          return Response.json({
            id: "fake-chat",
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "combined" } }],
          });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      await expectCliOk(cwd, ["init"]);
      await expectCliOk(cwd, [
        "llm",
        "add",
        "custom/prod",
        "--name",
        "fake-direct",
        "--schema",
        "openai",
        "--url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "target-model",
      ]);
      await expectCliOk(cwd, [
        "mcp",
        "add",
        "fake",
        "--transport",
        "stdio",
        "--command",
        "bun",
        "--args",
        fakeMcpPath,
        "--method-renames",
        "echo:fake_echo",
        "--method-blacklist",
        "dangerous",
      ]);

      const server = Bun.spawn({
        cmd: ["bun", cliPath, "serve", "--port", String(servePort)],
        cwd,
        env: testEnv(cwd),
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        await waitForHttp(`http://127.0.0.1:${servePort}/v1/models`, server);

        const stdout = await readOutputChunk(server.stdout);
        expect(stdout).toContain(`LLM base URL: http://localhost:${servePort}/v1`);
        expect(stdout).toContain(`MCP Streamable HTTP URL: http://localhost:${servePort}/mcp`);

        const chat = await fetch(`http://127.0.0.1:${servePort}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "custom/prod", messages: [] }),
        }).then((response) => response.json() as Promise<{ choices: Array<{ message: { content: string } }> }>);
        expect(chat.choices[0]?.message.content).toBe("combined");

        const client = new Client({ name: "http-e2e-client", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${servePort}/mcp`));

        try {
          await client.connect(transport);
          const tools = await client.listTools();
          expect(tools.tools.map((tool) => tool.name)).toEqual(["fake_echo"]);
        } finally {
          await client.close();
        }
      } finally {
        await stopProcess(server);
      }
    } finally {
      upstream.stop(true);
    }
  }, 15_000);

  test("serves a federated MCP stdio server through the CLI", async () => {
    const cwd = await createTempDir();
    const fakeMcpPath = await writeFakeMcpServer(cwd);

    await expectCliOk(cwd, ["init"]);
    await expectCliOk(cwd, [
      "mcp",
      "add",
      "fake",
      "--transport",
      "stdio",
      "--command",
      "bun",
      "--args",
      fakeMcpPath,
      "--method-renames",
      "echo:fake_echo",
      "--method-blacklist",
      "dangerous",
    ]);

    const listResult = await expectCliOk(cwd, ["mcp", "list"]);
    expect(listResult.stdout).toContain("fake\tstdio\tbun");

    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [cliPath, "serve", "mcp"],
      cwd,
      env: testEnv(cwd),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["fake_echo"]);

      const result = await client.callTool({
        name: "fake_echo",
        arguments: { message: "hello" },
      });
      expect(result.content).toEqual([{ type: "text", text: "fake:hello" }]);
    } finally {
      await client.close();
    }
  }, 15_000);
});
