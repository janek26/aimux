import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FederationConfig, McpServerConfig, MethodControls } from "../config/types.js";
import { ConfigOAuthClientProvider, createOAuthMetadata } from "./oauth.js";

type McpTool = ListToolsResult["tools"][number];
type McpPrompt = ListPromptsResult["prompts"][number];

type OwnedMethod<T> = {
  serverName: string;
  originalName: string;
  exposedName: string;
  item: T;
};

type McpRuntimeOptions = {
  onOAuthUpdate?: (serverName: string, server: McpServerConfig) => void | Promise<void>;
};

export type McpHttpHandler = ((request: Request) => Promise<Response>) & {
  close(): Promise<void>;
};

export type McpStdioSession = {
  close(): Promise<void>;
};

type McpClientFactory = (
  serverName: string,
  config: McpServerConfig,
  options?: McpRuntimeOptions,
) => Promise<McpClientPort>;

export type McpClientPort = {
  listTools(): Promise<ListToolsResult>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
  listPrompts(): Promise<ListPromptsResult>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<GetPromptResult>;
  listResources(): Promise<ListResourcesResult>;
  readResource(params: { uri: string }): Promise<ReadResourceResult>;
  close(): Promise<void>;
};

export class McpAuthError extends Error {
  constructor(serverName: string) {
    super(`MCP server ${serverName} requires valid authentication. Run ai-fed setup or ai-fed config validate to refresh it.`);
    this.name = "McpAuthError";
  }
}

const headersInit = (server: McpServerConfig): RequestInit =>
  server.headers ? { headers: server.headers } : {};

const authProvider = (
  serverName: string,
  server: McpServerConfig,
  options: McpRuntimeOptions = {},
): ConfigOAuthClientProvider | undefined =>
  server.oauth
    ? new ConfigOAuthClientProvider(
        server.oauth,
        createOAuthMetadata(serverName, "http://localhost"),
        () => undefined,
        "http://localhost",
        {
          onChange: () => options.onOAuthUpdate?.(serverName, server),
        },
      )
    : undefined;

export const createSdkClient = async (
  serverName: string,
  config: McpServerConfig,
  options: McpRuntimeOptions = {},
): Promise<McpClientPort> => {
  const client = new Client({ name: `ai-fed-${serverName}`, version: "0.1.0" });
  const transport =
    config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        })
      : config.transport === "sse"
        ? new SSEClientTransport(new URL(config.url), {
            authProvider: authProvider(serverName, config, options),
            requestInit: headersInit(config),
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            authProvider: authProvider(serverName, config, options),
            requestInit: headersInit(config),
          });

  await client.connect(transport);

  return {
    listTools: () => client.listTools(),
    callTool: async (params) => (await client.callTool(params)) as CallToolResult,
    listPrompts: () => client.listPrompts(),
    getPrompt: (params) => client.getPrompt(params),
    listResources: () => client.listResources(),
    readResource: (params) => client.readResource(params),
    close: () => client.close(),
  };
};

const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), 10_000);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const createClientWithTimeout = async (
  serverName: string,
  config: McpServerConfig,
  createClient: McpClientFactory,
  options: McpRuntimeOptions,
  message: string,
): Promise<McpClientPort> => {
  const clientPromise = createClient(serverName, config, options);

  try {
    return await withTimeout(clientPromise, message);
  } catch (error) {
    void clientPromise.then((client) => client.close()).catch(() => undefined);
    throw error;
  }
};

export const validateMcpServerConfig = async (
  serverName: string,
  config: McpServerConfig,
  createClient: McpClientFactory = createSdkClient,
  options: McpRuntimeOptions = {},
): Promise<void> => {
  const client = await createClientWithTimeout(
    serverName,
    config,
    createClient,
    options,
    `Timed out connecting to MCP server ${serverName}`,
  ).catch((error) => {
    if (error instanceof McpAuthError || error instanceof UnauthorizedError) {
      throw new McpAuthError(serverName);
    }

    throw new Error(`Could not connect to MCP server ${serverName}: ${String(error)}`);
  });

  try {
    const [tools, prompts] = await withTimeout(
      Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listPrompts().catch(() => ({ prompts: [] })),
      ]),
      `Timed out validating MCP server ${serverName}`,
    );
    const methodNames = new Set([
      ...tools.tools.map((tool) => tool.name),
      ...prompts.prompts.map((prompt) => prompt.name),
    ]);
    const configuredNames = [
      ...(config.method_whitelist ?? []),
      ...(config.method_blacklist ?? []),
      ...Object.keys(config.method_renames ?? {}),
    ];
    const missingNames = configuredNames.filter((name) => !methodNames.has(name));

    if (methodNames.size > 0 && missingNames.length > 0) {
      throw new Error(`MCP server ${serverName} does not expose method(s): ${missingNames.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof McpAuthError || error instanceof UnauthorizedError) {
      throw new McpAuthError(serverName);
    }

    throw error;
  } finally {
    await client.close();
  }
};

export const listMcpMethodNames = async (
  serverName: string,
  config: McpServerConfig,
  createClient: McpClientFactory = createSdkClient,
  options: McpRuntimeOptions = {},
): Promise<string[]> => {
  const client = await createClientWithTimeout(
    serverName,
    config,
    createClient,
    options,
    `Timed out connecting to MCP server ${serverName}`,
  );

  try {
    const [tools, prompts] = await withTimeout(
      Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listPrompts().catch(() => ({ prompts: [] })),
      ]),
      `Timed out listing MCP methods for ${serverName}`,
    );

    return [...new Set([
      ...tools.tools.map((tool) => tool.name),
      ...prompts.prompts.map((prompt) => prompt.name),
    ])].sort((left, right) => left.localeCompare(right));
  } finally {
    await client.close();
  }
};

const isAllowed = (name: string, controls: MethodControls): boolean => {
  if (controls.method_whitelist) {
    return controls.method_whitelist.includes(name);
  }

  return !(controls.method_blacklist ?? []).includes(name);
};

export const exposeMethodName = (name: string, controls: MethodControls): string =>
  controls.method_renames?.[name] ?? name;

export const applyMethodControls = <T extends { name: string }>(
  serverName: string,
  controls: MethodControls,
  items: T[],
  existingNames: ReadonlySet<string> = new Set(),
): Array<OwnedMethod<T>> => {
  const used = new Set(existingNames);

  return items.flatMap((item) => {
    if (!isAllowed(item.name, controls)) {
      return [];
    }

    const preferredName = exposeMethodName(item.name, controls);
    const exposedName = used.has(preferredName) ? `${serverName}.${preferredName}` : preferredName;
    used.add(exposedName);

    return [
      {
        serverName,
        originalName: item.name,
        exposedName,
        item,
      },
    ];
  });
};

export class McpFederation {
  constructor(private readonly clients: Record<string, { config: McpServerConfig; client: McpClientPort }>) {}

  static async fromConfig(
    config: FederationConfig,
    createClient: McpClientFactory = createSdkClient,
    options: McpRuntimeOptions = {},
  ): Promise<McpFederation> {
    const entries = await Promise.all(
      Object.entries(config.mcp ?? {}).map(async ([serverName, serverConfig]) => [
        serverName,
        {
          config: serverConfig,
          client: await createClient(serverName, serverConfig, options),
        },
      ] as const),
    );

    return new McpFederation(Object.fromEntries(entries));
  }

  async listTools(): Promise<ListToolsResult> {
    const ownedTools = await this.ownedTools();

    return {
      tools: ownedTools.map(({ exposedName, item, serverName }) => ({
        ...item,
        name: exposedName,
        description: item.description ?? `Forwarded from ${serverName}`,
      })),
    };
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const tool = (await this.ownedTools()).find((item) => item.exposedName === name);

    if (!tool) {
      throw new Error(`Unknown federated MCP tool: ${name}`);
    }

    const client = this.clients[tool.serverName]?.client;

    if (!client) {
      throw new Error(`MCP client for ${tool.serverName} is not available`);
    }

    return client.callTool({
      name: tool.originalName,
      arguments: args,
    });
  }

  async listPrompts(): Promise<ListPromptsResult> {
    const ownedPrompts = await this.ownedPrompts();

    return {
      prompts: ownedPrompts.map(({ exposedName, item }) => ({
        ...item,
        name: exposedName,
      })),
    };
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const prompt = (await this.ownedPrompts()).find((item) => item.exposedName === name);

    if (!prompt) {
      throw new Error(`Unknown federated MCP prompt: ${name}`);
    }

    const client = this.clients[prompt.serverName]?.client;

    if (!client) {
      throw new Error(`MCP client for ${prompt.serverName} is not available`);
    }

    return client.getPrompt({
      name: prompt.originalName,
      arguments: args,
    });
  }

  async listResources(): Promise<ListResourcesResult> {
    const results = await Promise.all(
      Object.entries(this.clients).map(async ([serverName, { client }]) => {
        try {
          const result = await client.listResources();
          return result.resources.map((resource) => ({
            ...resource,
            name: resource.name ?? `${serverName}:${resource.uri}`,
          }));
        } catch (error) {
          throw new Error(`Failed to list resources from ${serverName}: ${String(error)}`);
        }
      }),
    );

    return { resources: results.flat() };
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    for (const [serverName, { client }] of Object.entries(this.clients)) {
      const resources = await client.listResources();

      if (resources.resources.some((resource) => resource.uri === uri)) {
        try {
          return await client.readResource({ uri });
        } catch (error) {
          throw new Error(`Failed to read resource ${uri} from ${serverName}: ${String(error)}`);
        }
      }
    }

    throw new Error(`Unknown federated MCP resource: ${uri}`);
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.clients).map(({ client }) => client.close()));
  }

  private async ownedTools(): Promise<Array<OwnedMethod<McpTool>>> {
    return this.ownedMethods((client) => client.listTools().then((result) => result.tools));
  }

  private async ownedPrompts(): Promise<Array<OwnedMethod<McpPrompt>>> {
    return this.ownedMethods((client) => client.listPrompts().then((result) => result.prompts));
  }

  private async ownedMethods<T extends { name: string }>(
    list: (client: McpClientPort) => Promise<T[]>,
  ): Promise<Array<OwnedMethod<T>>> {
    const owned: Array<OwnedMethod<T>> = [];
    const used = new Set<string>();

    for (const [serverName, { client, config }] of Object.entries(this.clients)) {
      try {
        const result = await list(client);
        const controlled = applyMethodControls(serverName, config, result, used);
        controlled.forEach(({ exposedName }) => used.add(exposedName));
        owned.push(...controlled);
      } catch (error) {
        throw new Error(`Failed to list MCP methods from ${serverName}: ${String(error)}`);
      }
    }

    return owned;
  }
}

export const createMcpServer = (federation: McpFederation): Server => {
  const server = new Server(
    { name: "ai-fed", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => federation.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    federation.callTool(request.params.name, request.params.arguments as Record<string, unknown> | undefined),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () => federation.listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    federation.getPrompt(request.params.name, request.params.arguments),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => federation.listResources());
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    federation.readResource(request.params.uri),
  );

  return server;
};

export const serveMcpStdio = async (
  config: FederationConfig,
  options: McpRuntimeOptions = {},
): Promise<McpStdioSession> => {
  const federation = await McpFederation.fromConfig(config, createSdkClient, options);
  const server = createMcpServer(federation);
  await server.connect(new StdioServerTransport());

  return {
    close: async () => {
      await Promise.allSettled([
        server.close(),
        federation.close(),
      ]);
    },
  };
};

const closeResponseResources = async (
  server: Server,
  transport: WebStandardStreamableHTTPServerTransport,
): Promise<void> => {
  await Promise.allSettled([
    transport.close(),
    server.close(),
  ]);
};

const responseWithCleanup = (
  response: Response,
  cleanup: () => Promise<void>,
): Response => {
  let cleaned = false;
  const runCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      void cleanup();
    }
  };

  if (!response.body) {
    runCleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const result = await reader.read();

      if (result.done) {
        controller.close();
        runCleanup();
        return;
      }

      controller.enqueue(result.value);
    },
    cancel: async (reason) => {
      await reader.cancel(reason);
      runCleanup();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const createMcpHttpHandler = (
  config: FederationConfig,
  options: McpRuntimeOptions = {},
  createClient: McpClientFactory = createSdkClient,
): McpHttpHandler => {
  let federationPromise: Promise<McpFederation> | undefined;

  const getFederation = async (): Promise<McpFederation> => {
    if (!federationPromise) {
      federationPromise = McpFederation.fromConfig(config, createClient, options).catch((error) => {
        federationPromise = undefined;
        throw error;
      });
    }

    return federationPromise;
  };

  const handler = async (request: Request): Promise<Response> => {
    const federation = await getFederation();
    const server = createMcpServer(federation);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const cleanup = () => closeResponseResources(server, transport);

    try {
      await server.connect(transport);
      return responseWithCleanup(await transport.handleRequest(request), cleanup);
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

  handler.close = async (): Promise<void> => {
    const federation = await federationPromise?.catch(() => undefined);
    federationPromise = undefined;
    await federation?.close();
  };

  return handler;
};
