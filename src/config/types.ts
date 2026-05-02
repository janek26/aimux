export const CONFIG_FILE_NAME = ".aimux.yml";
export const CONFIG_FILE_NAMES = [CONFIG_FILE_NAME, ".aimux.yaml"] as const;

export const LLM_PRESETS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "groq",
  "ollama",
  "openrouter",
  "fireworks",
] as const;

export const LLM_SCHEMAS = ["openai", "anthropic"] as const;
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;

export type LlmPreset = (typeof LLM_PRESETS)[number];
export type LlmSchema = (typeof LLM_SCHEMAS)[number];
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type JsonObject = Record<string, unknown>;

export type PresetLlmProvider = {
  preset: LlmPreset;
  schema?: LlmSchema;
  url?: string;
  token?: string;
};

export type CustomLlmProvider = {
  preset?: never;
  schema: LlmSchema;
  url: string;
  token?: string;
};

export type LlmProvider = PresetLlmProvider | CustomLlmProvider;

export type LlmRoute = {
  provider: string;
  model: string;
};

export type LlmFallbackRoute = {
  provider: string;
  model_whitelist?: string[];
  model_blacklist?: string[];
};

export type LlmConfig = {
  fallback?: LlmFallbackRoute[];
} & Record<string, LlmFallbackRoute[] | LlmRoute | undefined>;

export type MethodControls = {
  method_whitelist?: string[];
  method_blacklist?: string[];
  method_renames?: Record<string, string>;
};

export type McpOAuthConfig = {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  client_id?: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
};

export type StdioMcpServerConfig = MethodControls & {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
  headers?: never;
  oauth?: never;
};

export type RemoteMcpServerConfig = MethodControls & {
  transport: Exclude<McpTransport, "stdio">;
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
};

export type McpServerConfig = StdioMcpServerConfig | RemoteMcpServerConfig;

export type AimuxConfig = {
  providers?: Record<string, LlmProvider>;
  llm?: LlmConfig;
  mcp?: Record<string, McpServerConfig>;
};

export type ConfigLocation = {
  path: string;
  config: AimuxConfig;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export type ConfigRepositoryPort = {
  findConfigPath(startDir?: string): Promise<string | undefined>;
  read(path?: string): Promise<ConfigLocation | undefined>;
  write(path: string, config: AimuxConfig): Promise<void>;
};

export type ConfigValidatorPort = {
  validate(config: AimuxConfig): Promise<ValidationResult>;
  assertValid(config: AimuxConfig): Promise<void>;
};
