#!/usr/bin/env bun
import { cancel, intro, isCancel, multiselect, outro, password, select, text } from "@clack/prompts";
import { createDefaultConfig, addLlmProvider, addMcpServer, listLlmProviders, listMcpServers, removeLlmProvider, removeMcpServer } from "./core/config.js";
import { HyperjumpConfigValidator } from "./config/validation.js";
import { YamlConfigRepository } from "./config/repository.js";
import {
  LLM_PRESETS,
  LLM_SCHEMAS,
  MCP_TRANSPORTS,
  type FederationConfig,
  type LlmProvider,
  type LlmPreset,
  type LlmSchema,
  type McpOAuthConfig,
  type McpServerConfig,
  type McpTransport,
} from "./config/types.js";
import { createLlmHttpHandler } from "./llm/gateway.js";
import { validateLlmProviderRoute } from "./llm/preflight.js";
import { createMcpHttpHandler, listMcpMethodNames, McpAuthError, serveMcpStdio, validateMcpServerConfig } from "./mcp/gateway.js";
import { ConfigOAuthClientProvider, createOAuthMetadata } from "./mcp/oauth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

type ParsedArgs = {
  command: string[];
  flags: Record<string, string | boolean>;
};

type CliContext = {
  cwd: string;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

const help = `ai-fed

Commands:
  ai-fed init [--path <path>] [--global] [--force]
  ai-fed setup
  ai-fed config path
  ai-fed config validate
  ai-fed llm add fallback --name <provider> (--preset <preset> | --schema <schema> --url <url>)
  ai-fed llm add <custom-model> --name <provider> --model <upstream-model>
  ai-fed llm remove <name>
  ai-fed llm list
  ai-fed mcp add [name] [url] --transport <stdio|http|sse> [--command <command>]
  ai-fed mcp remove <name>
  ai-fed mcp list
  ai-fed serve [--port <port>] [--frozen]
  ai-fed serve llm [--port <port>]
  ai-fed serve mcp [--frozen]
`;

const parseCsv = (value?: string | boolean): string[] | undefined =>
  typeof value === "string" && value.length > 0 ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;

const parseKeyValueMap = (value?: string | boolean): Record<string, string> | undefined => {
  const entries = parseCsv(value)?.map((item) => {
    const separatorIndex = item.includes("=") ? item.indexOf("=") : item.indexOf(":");

    if (separatorIndex < 1) {
      throw new Error(`Expected key/value pair, got: ${item}`);
    }

    return [item.slice(0, separatorIndex).trim(), item.slice(separatorIndex + 1).trim()] as const;
  });

  return entries && entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const waitForever = (): Promise<never> => new Promise(() => undefined);

const LLM_MCP_IDLE_TIMEOUT_SECONDS = 255;

type HttpHandler = (request: Request) => Response | Promise<Response>;
type HttpLogger = (message: string) => void;

const compactLogValue = (value?: string | null): string =>
  value && value.length > 0 ? value.replace(/\s+/g, "_").slice(0, 80) : "-";

const responseIsStreaming = (response: Response): boolean => {
  const contentType = response.headers.get("content-type") ?? "";

  return response.body !== null &&
    (contentType.includes("text/event-stream") ||
      contentType.includes("application/x-ndjson") ||
      response.headers.get("transfer-encoding") === "chunked");
};

const isLongRunningGatewayRequest = (request: Request, pathname: string): boolean =>
  pathname === "/mcp" || (request.method === "POST" && pathname === "/v1/chat/completions");

const withHttpDebugLogging =
  (scope: string, handler: HttpHandler, logger: HttpLogger): HttpHandler =>
  async (request, server?: Bun.Server<unknown>) => {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    const hasLongRunningTimeout = isLongRunningGatewayRequest(request, url.pathname);

    if (hasLongRunningTimeout) {
      server?.timeout(request, 0);
    }

    try {
      const response = await handler(request);
      const durationMs = Math.round(performance.now() - startedAt);
      const stream = responseIsStreaming(response) ? " stream=1" : "";
      const timeout = hasLongRunningTimeout ? " timeout=off" : "";
      logger(
        `[${scope}] ${requestId} ${request.method} ${url.pathname} -> ${response.status} ${durationMs}ms${stream}${timeout} ` +
          `req=${compactLogValue(request.headers.get("content-type"))}/${compactLogValue(request.headers.get("content-length"))} ` +
          `res=${compactLogValue(response.headers.get("content-type"))}/${compactLogValue(response.headers.get("content-length"))} ` +
          `ua=${compactLogValue(request.headers.get("user-agent"))}`,
      );
      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      logger(
        `[${scope}] ${requestId} ${request.method} ${url.pathname} -> error ${durationMs}ms ` +
          `err=${compactLogValue(error instanceof Error ? error.message : String(error))}`,
      );
      throw error;
    }
  };

const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .map(([key, nestedValue]) => [key, stripUndefined(nestedValue)]),
  );
};

const persistedOAuthConfig = (oauth: McpOAuthConfig): McpOAuthConfig =>
  stripUndefined({
    access_token: oauth.access_token,
    token_type: oauth.token_type,
    refresh_token: oauth.refresh_token,
    id_token: oauth.id_token,
    expires_in: oauth.expires_in,
    scope: oauth.scope,
    client_id: oauth.client_id,
    client_secret: oauth.client_secret,
    client_id_issued_at: oauth.client_id_issued_at,
    client_secret_expires_at: oauth.client_secret_expires_at,
  }) as McpOAuthConfig;

const hasOAuthAccessToken = (server: McpServerConfig): boolean =>
  typeof server.oauth?.access_token === "string" && server.oauth.access_token.length > 0 &&
  typeof server.oauth.token_type === "string" && server.oauth.token_type.length > 0;

export const parseArgs = (argv: string[]): ParsedArgs => {
  const result: ParsedArgs = { command: [], flags: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      result.command.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);

    if (inlineValue !== undefined) {
      result.flags[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];

    if (next && !next.startsWith("--")) {
      result.flags[rawKey] = next;
      index += 1;
      continue;
    }

    result.flags[rawKey] = true;
  }

  return result;
};

const stringFlag = (flags: ParsedArgs["flags"], name: string): string | undefined =>
  typeof flags[name] === "string" ? flags[name] : undefined;

const serverOrigin = (port: number): string => `http://localhost:${port}`;

const currentCliCommand = (): string => {
  const invokedCommand = process.argv[1] ?? Bun.argv[1];

  if (!invokedCommand || invokedCommand.startsWith("/$bunfs/")) {
    const executable = process.argv[0];
    const executableName = executable?.split(/[\\/]/).at(-1);

    return executable && !executable.startsWith("/$bunfs/") && executableName !== "bun" ? executable : "ai-fed";
  }

  return invokedCommand;
};

const formatCombinedServeDetails = (port: number): string => {
  const origin = serverOrigin(port);

  return [
    `AI Federation serving on ${origin}`,
    `LLM base URL: ${origin}/v1`,
    `LLM models URL: ${origin}/v1/models`,
    `LLM chat completions URL: ${origin}/v1/chat/completions`,
    `MCP Streamable HTTP URL: ${origin}/mcp`,
    `MCP stdio command: ${currentCliCommand()} serve mcp`,
  ].join("\n");
};

const formatLlmServeDetails = (port: number): string => {
  const origin = serverOrigin(port);

  return [
    `LLM gateway serving on ${origin}`,
    `Base URL: ${origin}/v1`,
    `Models URL: ${origin}/v1/models`,
    `Chat completions URL: ${origin}/v1/chat/completions`,
  ].join("\n");
};

const formatMcpStdioServeDetails = (): string =>
  [
    "MCP stdio server running.",
    `Configure MCP clients with command: ${currentCliCommand()}`,
    "Arguments: serve mcp",
  ].join("\n");

const requireSelection = async <T extends string>(value: Promise<T | symbol>): Promise<T> => {
  const selected = await value;

  if (isCancel(selected)) {
    cancel("Cancelled");
    process.exit(0);
  }

  return selected;
};

const requireMultiSelection = async <T extends string>(value: Promise<T[] | symbol>): Promise<T[]> => {
  const selected = await value;

  if (isCancel(selected)) {
    cancel("Cancelled");
    process.exit(0);
  }

  return selected;
};

const promptText = async (message: string, initialValue?: string): Promise<string> =>
  requireSelection(
    text({
      message,
      initialValue,
      validate: (value) => (!value || value.length === 0 ? "Required" : undefined),
    }),
  );

const promptOptionalSecret = async (message: string): Promise<string | undefined> => {
  const value = await password({ message, mask: "*" });

  if (isCancel(value) || typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
};

const isTty = (): boolean => Boolean(process.stdin.isTTY);

const usesPromptUi = (args: ParsedArgs): boolean => {
  const [domain, action] = args.command;

  return (
    domain === "init" ||
    domain === "setup" ||
    (domain === "config" && action === "init") ||
    (domain === "config" && action === "validate") ||
    (domain === "llm" && action === "add") ||
    (domain === "mcp" && action === "add")
  );
};

const resolveInitPath = async (
  args: ParsedArgs,
  repository: YamlConfigRepository,
  cwd: string,
): Promise<string> => {
  const path = stringFlag(args.flags, "path");

  if (path) {
    return path;
  }

  if (args.flags.global || !isTty()) {
    return args.flags.global ? repository.getDefaultHomePath() : repository.getDefaultProjectPath(cwd);
  }

  const location = await requireSelection(
    select({
      message: "Where should ai-fed create .mcp-federation.yml?",
      options: [
        { label: "Current directory", value: "current" },
        { label: "Home directory", value: "home" },
      ],
    }),
  );

  return location === "home" ? repository.getDefaultHomePath() : repository.getDefaultProjectPath(cwd);
};

const createRepository = () => new YamlConfigRepository(new HyperjumpConfigValidator());
const createValidator = () => new HyperjumpConfigValidator();

const readConfigFrom = async (
  repository: YamlConfigRepository,
  cwd: string,
): Promise<{ path: string; config: FederationConfig } | undefined> => {
  const path = await repository.findConfigPath(cwd);
  return path ? repository.read(path) : undefined;
};

const ensureConfigLocation = async (
  repository: YamlConfigRepository,
  cwd: string,
): Promise<{ path: string; config: FederationConfig }> => {
  const existing = await readConfigFrom(repository, cwd);

  if (existing) {
    return existing;
  }

  if (!isTty()) {
    return {
      path: repository.getDefaultProjectPath(cwd),
      config: createDefaultConfig(),
    };
  }

  const location = await requireSelection(
    select({
      message: "No .mcp-federation.yml found. Where should it be created?",
      options: [
        { label: "Current directory", value: "current" },
        { label: "Home directory", value: "home" },
      ],
    }),
  );

  return {
    path: location === "home" ? repository.getDefaultHomePath() : repository.getDefaultProjectPath(cwd),
    config: createDefaultConfig(),
  };
};

const assertEnum = <T extends string>(value: string | undefined, values: readonly T[], label: string): T | undefined => {
  if (!value) {
    return undefined;
  }

  if (values.includes(value as T)) {
    return value as T;
  }

  throw new Error(`${label} must be one of: ${values.join(", ")}`);
};

const collectLlmProvider = async (args: ParsedArgs, config: FederationConfig): Promise<{
  target: string;
  providerName: string;
  provider: LlmProvider;
  routeOptions: { model?: string; model_whitelist?: string[]; model_blacklist?: string[] };
}> => {
  const [targetArg] = args.command.slice(2);
  const target = targetArg ?? (isTty() ? await promptText("Model target or fallback", "fallback") : "fallback");
  const name = stringFlag(args.flags, "name") ?? (isTty() ? await promptText("Provider name") : undefined);
  const preset = assertEnum(stringFlag(args.flags, "preset"), LLM_PRESETS, "preset");
  const schema = assertEnum(stringFlag(args.flags, "schema"), LLM_SCHEMAS, "schema");

  if (!name) {
    throw new Error("Missing --name");
  }
  const existingProvider = config.providers?.[name];
  const hasProviderFlags = Boolean(preset || schema || stringFlag(args.flags, "url") || stringFlag(args.flags, "token"));

  const selectedPreset =
    preset ??
    (existingProvider && !hasProviderFlags
      ? undefined
      : schema
      ? undefined
      : isTty()
        ? await requireSelection(
            select({
              message: "Provider preset",
              options: LLM_PRESETS.map((value) => ({ label: value, value })),
            }),
          )
        : undefined);
  const selectedSchema =
    schema ??
    (existingProvider && !hasProviderFlags
      ? undefined
      : selectedPreset
      ? undefined
      : isTty()
        ? await requireSelection(
            select({
              message: "Provider schema",
              options: LLM_SCHEMAS.map((value) => ({ label: value, value })),
            }),
          )
        : undefined);
  const url = stringFlag(args.flags, "url") ?? (selectedSchema && isTty() ? await promptText("Provider base URL") : undefined);
  const token = stringFlag(args.flags, "token") ??
    (existingProvider && !hasProviderFlags ? undefined : isTty() ? await promptOptionalSecret("Token (optional)") : undefined);
  const model = stringFlag(args.flags, "model") ??
    (target !== "fallback" && isTty() ? await promptText("Upstream model to redirect to") : undefined);

  if (!selectedPreset && (!selectedSchema || !url) && !existingProvider) {
    throw new Error("Provide --preset or --schema with --url, or reference an existing provider with --name");
  }

  if (target !== "fallback" && !model) {
    throw new Error("Custom LLM targets require --model <upstream-model>");
  }

  return {
    target,
    providerName: name,
    provider: existingProvider && !hasProviderFlags ? {} : {
      preset: selectedPreset as LlmPreset | undefined,
      schema: selectedSchema as LlmSchema | undefined,
      url,
      token,
    },
    routeOptions: {
      model,
      model_whitelist: parseCsv(args.flags["model-whitelist"]),
      model_blacklist: parseCsv(args.flags["model-blacklist"]),
    },
  };
};

const collectMcpServer = async (args: ParsedArgs): Promise<{ name: string; server: McpServerConfig }> => {
  const [, , nameArg, urlArg] = args.command;
  const transport = assertEnum(stringFlag(args.flags, "transport"), MCP_TRANSPORTS, "transport") ??
    (isTty()
      ? await requireSelection(
          select({
            message: "MCP transport",
            options: MCP_TRANSPORTS.map((value) => ({ label: value, value })),
          }),
        )
      : undefined);
  const name = nameArg ?? (isTty() ? await promptText("Server name") : undefined);

  if (!name) {
    throw new Error("Missing MCP server name");
  }

  if (!transport) {
    throw new Error("Missing --transport");
  }

  if (transport === "stdio") {
    const command = stringFlag(args.flags, "command") ?? (isTty() ? await promptText("Command") : undefined);

    if (!command) {
      throw new Error("Missing --command for stdio MCP server");
    }

    return {
      name,
      server: {
        transport,
        command,
        args: parseCsv(args.flags.args),
        env: parseKeyValueMap(args.flags.env),
        cwd: stringFlag(args.flags, "cwd"),
        method_whitelist: parseCsv(args.flags["method-whitelist"]),
        method_blacklist: parseCsv(args.flags["method-blacklist"]),
        method_renames: parseKeyValueMap(args.flags["method-renames"]),
      },
    };
  }

  const url = urlArg ?? stringFlag(args.flags, "url") ?? (isTty() ? await promptText("URL") : undefined);

  if (!url) {
    throw new Error("Missing MCP URL");
  }

  return {
    name,
    server: {
      transport,
      url,
      headers: parseKeyValueMap(args.flags.header ?? args.flags.headers),
      method_whitelist: parseCsv(args.flags["method-whitelist"]),
      method_blacklist: parseCsv(args.flags["method-blacklist"]),
      method_renames: parseKeyValueMap(args.flags["method-renames"]),
    },
  };
};

const hasMethodControlFlags = (args: ParsedArgs): boolean =>
  Boolean(args.flags["method-whitelist"] || args.flags["method-blacklist"] || args.flags["method-renames"]);

const collectMcpMethodControls = async (
  name: string,
  server: McpServerConfig,
  args: ParsedArgs,
): Promise<McpServerConfig> => {
  if (!isTty() || hasMethodControlFlags(args)) {
    return server;
  }

  const methodNames = await listMcpMethodNames(name, server);

  if (methodNames.length === 0) {
    return server;
  }

  const controlMode = await requireSelection(
    select({
      message: "Filter exposed MCP methods?",
      options: [
        { label: "Expose all methods", value: "none" },
        { label: "Whitelist selected methods", value: "whitelist" },
        { label: "Blacklist selected methods", value: "blacklist" },
      ],
    }),
  );

  if (controlMode === "none") {
    return server;
  }

  const selectedMethods = await requireMultiSelection(
    multiselect({
      message: controlMode === "whitelist" ? "Methods to expose" : "Methods to hide",
      options: methodNames.map((methodName) => ({ label: methodName, value: methodName })),
      required: true,
      maxItems: 12,
    }),
  );

  return {
    ...server,
    method_whitelist: controlMode === "whitelist" ? selectedMethods : undefined,
    method_blacklist: controlMode === "blacklist" ? selectedMethods : undefined,
  };
};

const validateMcpAddConfig = async (name: string, server: McpServerConfig): Promise<McpServerConfig> => {
  const isRemote = server.transport !== "stdio";
  const hasStaticAuth = Boolean(server.headers?.Authorization);
  const hasOAuth = hasOAuthAccessToken(server);

  if (isTty() && isRemote && !hasStaticAuth) {
    if (hasOAuth) {
      try {
        await validateMcpServerConfig(name, server);
        return server;
      } catch (error) {
        if (!(error instanceof McpAuthError)) {
          throw error;
        }

        console.error(`Stored OAuth token for ${name} is invalid or expired. Starting OAuth setup again.`);
      }
    }

    console.error("Checking MCP server authentication...");

    try {
      return await runMcpOAuthSetup(name, {
        ...server,
        oauth: undefined,
      });
    } catch (error) {
      console.error(`OAuth setup did not complete: ${error instanceof Error ? error.message : String(error)}`);
      return validateMcpWithManualAuth(name, server);
    }
  }

  await validateMcpServerConfig(name, server);
  return server;
};

const validateMcpWithManualAuth = async (name: string, server: McpServerConfig): Promise<McpServerConfig> => {
  const method = await requireSelection(
    select({
      message: "How should ai-fed authenticate to this MCP server?",
      options: [
        { label: "Bearer token", value: "bearer" },
        { label: "Custom header", value: "header" },
        { label: "No auth / retry without auth", value: "none" },
      ],
    }),
  );

  if (method === "none") {
    await validateMcpServerConfig(name, server);
    return server;
  }

  const headerName = method === "header" ? await promptText("Header name", "Authorization") : "Authorization";
  const rawHeaderValue = await promptOptionalSecret(
    method === "bearer" ? "Bearer token" : `Value for ${headerName}`,
  );

  if (!rawHeaderValue) {
    throw new Error("Authentication value is required");
  }

  const authenticatedServer = {
    ...server,
    oauth: undefined,
    headers: {
      ...(server.headers ?? {}),
      [headerName]: method === "bearer" ? `Bearer ${rawHeaderValue}` : rawHeaderValue,
    },
  };

  await validateMcpServerConfig(name, authenticatedServer);
  return authenticatedServer;
};

const runMcpOAuthSetup = async (name: string, server: McpServerConfig): Promise<McpServerConfig> => {
  if (!server.url || server.transport === "stdio") {
    throw new Error("OAuth setup requires a remote MCP URL");
  }

  let finishAuth: ((code: string) => Promise<void>) | undefined;
  let finishError: ((error: Error) => void) | undefined;
  const callbackPromise = new Promise<void>((resolve, reject) => {
    finishAuth = async (code) => {
      try {
        await transport.finishAuth(code);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    finishError = reject;
  });
  const callbackServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: LLM_MCP_IDLE_TIMEOUT_SECONDS,
    fetch: withHttpDebugLogging("oauth-callback", async (request) => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        finishError?.(new Error(error));
        return new Response("<h1>Authorization failed</h1><p>You can close this window.</p>", {
          status: 400,
          headers: { "content-type": "text/html" },
        });
      }

      if (!code) {
        return new Response("<h1>Missing authorization code</h1>", {
          status: 400,
          headers: { "content-type": "text/html" },
        });
      }

      await finishAuth?.(code);
      return new Response("<h1>Authorization successful</h1><p>You can close this window and return to ai-fed.</p>", {
        headers: { "content-type": "text/html" },
      });
    }, console.error),
  });
  const redirectUrl = `http://localhost:${callbackServer.port}/auth/callback/${encodeURIComponent(name)}`;
  const oauth: McpOAuthConfig = { ...(server.oauth ?? {}) };
  let authorizationUrl: URL | undefined;
  const provider = new ConfigOAuthClientProvider(
    oauth,
    createOAuthMetadata(name, redirectUrl),
    (url) => {
      authorizationUrl = url;
    },
    redirectUrl,
  );
  const transport = server.transport === "sse"
    ? new SSEClientTransport(new URL(server.url), {
        authProvider: provider,
        requestInit: server.headers ? { headers: server.headers } : undefined,
      })
    : new StreamableHTTPClientTransport(new URL(server.url), {
        authProvider: provider,
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
  const client = new Client({ name: `ai-fed-${name}-auth`, version: "0.1.0" });
  let connectedWithoutOAuth = false;

  try {
    await client.connect(transport);
    connectedWithoutOAuth = true;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
  }

  if (connectedWithoutOAuth) {
    callbackServer.stop(true);
    await client.close().catch(() => undefined);
    console.error("MCP server is reachable without OAuth.");
    await validateMcpServerConfig(name, server);
    return server;
  }

  if (!authorizationUrl) {
    callbackServer.stop(true);
    await client.close().catch(() => undefined);
    throw new Error(`MCP server ${name} did not provide an OAuth authorization URL`);
  }

  console.error("MCP OAuth required. Open this URL to authorize:");
  console.error(String(authorizationUrl));
  console.error(`Waiting for callback on ${redirectUrl}`);

  try {
    await callbackPromise;
    await client.close().catch(() => undefined);
    const authenticatedServer = {
      ...server,
      oauth: persistedOAuthConfig(oauth),
    };

    if (!hasOAuthAccessToken(authenticatedServer)) {
      throw new Error(`OAuth setup for ${name} completed without an access token`);
    }

    await validateMcpServerConfig(name, authenticatedServer);
    return authenticatedServer;
  } finally {
    callbackServer.stop(true);
  }
};

const validateConfigPreflight = async (config: FederationConfig): Promise<FederationConfig> => {
  await createValidator().assertValid(config);

  for (const { target, providerName, provider, route } of listLlmProviders(config)) {
    try {
      await validateLlmProviderRoute(providerName, provider, route);
    } catch (error) {
      throw new Error(`LLM ${target} failed validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const mcpEntries = await Promise.all(
    Object.entries(config.mcp ?? {}).map(async ([name, server]) => {
      try {
        return [name, await validateMcpAddConfig(name, server)] as const;
      } catch (error) {
        throw new Error(`MCP ${name} failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  return mcpEntries.length > 0
    ? {
        ...config,
        mcp: Object.fromEntries(mcpEntries),
      }
    : config;
};

const validateMcpServersForServe = async (
  config: FederationConfig,
  onOAuthUpdate?: (serverName: string, server: McpServerConfig) => void | Promise<void>,
): Promise<void> => {
  await createValidator().assertValid(config);

  for (const [name, server] of Object.entries(config.mcp ?? {})) {
    try {
      await validateMcpServerConfig(name, server, undefined, { onOAuthUpdate });
    } catch (error) {
      throw new Error(`MCP ${name} is not ready to serve: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const formatLlmList = (config: FederationConfig): string =>
  listLlmProviders(config)
    .map(({ target, providerName, provider }) => `${target}\t${providerName}\t${provider.preset ?? provider.schema}`)
    .join("\n");

const formatMcpList = (config: FederationConfig): string =>
  listMcpServers(config)
    .map(({ name, server }) => `${name}\t${server.transport}\t${server.url ?? server.command}`)
    .join("\n");

export const runCli = async (argv: string[], context: CliContext = {
  cwd: process.cwd(),
  stdout: console.log,
  stderr: console.error,
}): Promise<number> => {
  const args = parseArgs(argv);
  const [domain, action] = args.command;
  const repository = createRepository();
  const shouldUsePromptUi = isTty() && usesPromptUi(args);

  try {
    if (!domain || domain === "--help" || domain === "help") {
      context.stdout(help);
      return 0;
    }

    if (shouldUsePromptUi) {
      intro("ai-fed");
    }

    if (domain === "init" || (domain === "config" && action === "init")) {
      const path = await resolveInitPath(args, repository, context.cwd);
      const exists = await Bun.file(path).exists();

      if (exists && !args.flags.force) {
        throw new Error(`Config already exists at ${path}. Use --force to overwrite.`);
      }

      await repository.write(path, createDefaultConfig());
      context.stdout(path);
      return 0;
    }

    if (domain === "config" && action === "path") {
      const path = await repository.findConfigPath(context.cwd);
      context.stdout(path ?? "No config found");
      return path ? 0 : 1;
    }

    if ((domain === "config" && action === "validate") || domain === "setup") {
      const location = await readConfigFrom(repository, context.cwd);

      if (!location) {
        throw new Error("No config found");
      }

      const validatedConfig = stripUndefined(await validateConfigPreflight(location.config)) as FederationConfig;
      await repository.write(location.path, validatedConfig);
      context.stdout(`Valid config: ${location.path}`);
      return 0;
    }

    if (domain === "llm" && action === "add") {
      const location = await ensureConfigLocation(repository, context.cwd);
      const { target, providerName, provider, routeOptions } = await collectLlmProvider(args, location.config);
      const nextConfig = stripUndefined(
        addLlmProvider(location.config, target, providerName, provider, routeOptions),
      ) as FederationConfig;
      const route = target === "fallback"
        ? nextConfig.llm?.fallback?.at(-1)
        : nextConfig.llm?.[target];
      const providerToValidate = nextConfig.providers?.[providerName];

      await createValidator().assertValid(nextConfig);

      if (!providerToValidate || !route || Array.isArray(route)) {
        throw new Error(`Could not validate LLM provider ${providerName}`);
      }

      await validateLlmProviderRoute(providerName, providerToValidate, route);
      await repository.write(location.path, nextConfig);
      context.stdout(`Added LLM provider ${providerName}`);
      return 0;
    }

    if (domain === "llm" && action === "remove") {
      const [, , name] = args.command;
      const location = await readConfigFrom(repository, context.cwd);

      if (!location || !name) {
        throw new Error(!name ? "Missing provider name" : "No config found");
      }

      const result = removeLlmProvider(location.config, name);

      if (!result.removed) {
        throw new Error(`No LLM provider named ${name}`);
      }

      await repository.write(location.path, result.config);
      context.stdout(`Removed LLM provider ${name}`);
      return 0;
    }

    if (domain === "llm" && action === "list") {
      const location = await readConfigFrom(repository, context.cwd);
      const output = location ? formatLlmList(location.config) : "";
      context.stdout(output.length > 0 ? output : "No LLM providers configured");
      return 0;
    }

    if (domain === "mcp" && action === "add") {
      const location = await ensureConfigLocation(repository, context.cwd);
      const { name, server } = await collectMcpServer(args);
      await createValidator().assertValid(stripUndefined(addMcpServer(location.config, name, server)) as FederationConfig);
      const validatedServer = await validateMcpAddConfig(name, server);
      const controlledServer = await collectMcpMethodControls(name, validatedServer, args);
      await validateMcpServerConfig(name, controlledServer);
      const nextConfig = stripUndefined(addMcpServer(location.config, name, controlledServer)) as FederationConfig;
      await createValidator().assertValid(nextConfig);
      await repository.write(location.path, nextConfig);
      context.stdout(`Added MCP server ${name}`);
      return 0;
    }

    if (domain === "mcp" && action === "remove") {
      const [, , name] = args.command;
      const location = await readConfigFrom(repository, context.cwd);

      if (!location || !name) {
        throw new Error(!name ? "Missing MCP server name" : "No config found");
      }

      const result = removeMcpServer(location.config, name);

      if (!result.removed) {
        throw new Error(`No MCP server named ${name}`);
      }

      await repository.write(location.path, result.config);
      context.stdout(`Removed MCP server ${name}`);
      return 0;
    }

    if (domain === "mcp" && action === "list") {
      const location = await readConfigFrom(repository, context.cwd);
      const output = location ? formatMcpList(location.config) : "";
      context.stdout(output.length > 0 ? output : "No MCP servers configured");
      return 0;
    }

    if (domain === "serve" && !action) {
      const location = await readConfigFrom(repository, context.cwd);

      if (!location) {
        throw new Error("No config found");
      }

      const port = Number(stringFlag(args.flags, "port") ?? 8787);
      const frozen = Boolean(args.flags.frozen);
      const persistOAuthUpdate = async () => {
        if (!frozen) {
          await repository.write(location.path, stripUndefined(location.config) as FederationConfig);
        }
      };
      await validateMcpServersForServe(location.config, persistOAuthUpdate);
      await persistOAuthUpdate();
      const llmHandler = createLlmHttpHandler(location.config);
      const mcpHandler = createMcpHttpHandler(location.config, { onOAuthUpdate: persistOAuthUpdate });

      Bun.serve({
        port,
        idleTimeout: LLM_MCP_IDLE_TIMEOUT_SECONDS,
        fetch: withHttpDebugLogging("serve", (request) => {
          const url = new URL(request.url);

          if (url.pathname === "/mcp") {
            return mcpHandler(request);
          }

          return llmHandler(request);
        }, context.stderr),
      });
      context.stdout(formatCombinedServeDetails(port));
      await waitForever();
    }

    if (domain === "serve" && action === "llm") {
      const location = await readConfigFrom(repository, context.cwd);

      if (!location) {
        throw new Error("No config found");
      }

      const port = Number(stringFlag(args.flags, "port") ?? 8787);
      Bun.serve({
        port,
        idleTimeout: LLM_MCP_IDLE_TIMEOUT_SECONDS,
        fetch: withHttpDebugLogging("serve:llm", createLlmHttpHandler(location.config), context.stderr),
      });
      context.stdout(formatLlmServeDetails(port));
      await waitForever();
    }

    if (domain === "serve" && action === "mcp") {
      const location = await readConfigFrom(repository, context.cwd);

      if (!location) {
        throw new Error("No config found");
      }

      const frozen = Boolean(args.flags.frozen);
      const persistOAuthUpdate = async () => {
        if (!frozen) {
          await repository.write(location.path, stripUndefined(location.config) as FederationConfig);
        }
      };
      await validateMcpServersForServe(location.config, persistOAuthUpdate);
      await persistOAuthUpdate();
      context.stderr(formatMcpStdioServeDetails());
      await serveMcpStdio(location.config, { onOAuthUpdate: persistOAuthUpdate });
      await waitForever();
    }

    throw new Error(`Unknown command: ${args.command.join(" ")}`);
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (shouldUsePromptUi) {
      outro("done");
    }
  }
};

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  process.exit(exitCode);
}
