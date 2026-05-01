import type { FederationConfig, LlmConfig, LlmFallbackRoute, LlmProvider, LlmRoute, McpServerConfig } from "../config/types.js";

export type LlmListItem = {
  target: string;
  providerName: string;
  provider: LlmProvider;
  route: LlmRoute | LlmFallbackRoute;
};

export type LlmRouteListItem = {
  target: string;
  providerName: string;
  provider?: LlmProvider;
  route: LlmRoute;
};

export type McpListItem = {
  name: string;
  server: McpServerConfig;
};

type LlmRouteOptions = {
  model?: string;
  model_whitelist?: string[];
  model_blacklist?: string[];
};

const isFallbackTarget = (target: string): boolean => target === "fallback";

export const createDefaultConfig = (): FederationConfig => ({});

const getProvider = (config: FederationConfig, providerName: string): LlmProvider | undefined =>
  config.providers?.[providerName];

const withFallbackLast = (
  entries: Array<[string, LlmRoute]>,
  fallback?: LlmFallbackRoute[],
): LlmConfig =>
  ({
    ...Object.fromEntries(entries),
    ...(fallback && fallback.length > 0 ? { fallback } : {}),
  }) as LlmConfig;

export const listLlmProviders = (config: FederationConfig): LlmListItem[] => {
  const llm = config.llm ?? {};
  const mapped = Object.entries(llm)
    .filter(([target]) => !isFallbackTarget(target))
    .flatMap(([target, value]) => {
      if (!value || Array.isArray(value)) {
        return [];
      }

      const provider = getProvider(config, value.provider);

      return provider
        ? [
            {
              target,
              providerName: value.provider,
              provider,
              route: value,
            },
          ]
        : [];
    });
  const fallback = (llm.fallback ?? [])
    .flatMap((route) => {
      const provider = getProvider(config, route.provider);

      return provider
        ? [
            {
              target: "fallback",
              providerName: route.provider,
              provider,
              route,
            },
          ]
        : [];
    });

  return [...mapped, ...fallback];
};

export const listLlmRoutes = (config: FederationConfig): LlmRouteListItem[] => {
  const llm = config.llm ?? {};
  return Object.entries(llm)
    .filter(([target]) => !isFallbackTarget(target))
    .flatMap(([target, value]) =>
      value && !Array.isArray(value)
        ? [{ target, providerName: value.provider, provider: config.providers?.[value.provider], route: value }]
        : [],
    );
};

export const listMcpServers = (config: FederationConfig): McpListItem[] =>
  Object.entries(config.mcp ?? {}).map(([name, server]) => ({ name, server }));

export const assertUniqueProviderName = (
  config: FederationConfig,
  providerName: string,
  replacingName?: string,
): void => {
  const existing = Object.keys(config.providers ?? {}).filter((name) => name !== replacingName);

  if (existing.includes(providerName)) {
    throw new Error(`LLM provider name already exists: ${providerName}`);
  }
};

export const addLlmProvider = (
  config: FederationConfig,
  target: string,
  providerName: string,
  provider: LlmProvider | undefined,
  routeOptions: LlmRouteOptions = {},
): FederationConfig => {
  if (!isFallbackTarget(target) && !routeOptions.model) {
    throw new Error("Custom LLM targets require an upstream model");
  }

  const existingRoute = target !== "fallback" && config.llm && !Array.isArray(config.llm[target])
    ? config.llm[target]
    : undefined;
  const existingProvider = config.providers?.[providerName];
  const hasProviderDetails = Boolean(provider);

  if (existingProvider && hasProviderDetails && existingRoute?.provider !== providerName) {
    throw new Error(`LLM provider name already exists: ${providerName}`);
  }

  if (!existingProvider && !hasProviderDetails) {
    throw new Error(`Unknown LLM provider: ${providerName}`);
  }

  if (!existingProvider) {
    assertUniqueProviderName(config, providerName, existingRoute?.provider);
  }
  const nextProvider = existingProvider ?? provider;

  if (!nextProvider) {
    throw new Error(`Unknown LLM provider: ${providerName}`);
  }

  if (isFallbackTarget(target)) {
    const route: LlmFallbackRoute = {
      provider: providerName,
      model_whitelist: routeOptions.model_whitelist,
      model_blacklist: routeOptions.model_blacklist,
    };
    const nonFallbackEntries = Object.entries(config.llm ?? {}).flatMap(([key, value]) =>
      key !== "fallback" && value && !Array.isArray(value) ? ([[key, value]] as Array<[string, LlmRoute]>) : [],
    );

    return {
      ...config,
      providers: {
        ...(config.providers ?? {}),
        [providerName]: nextProvider,
      },
      llm: withFallbackLast(nonFallbackEntries, [...(config.llm?.fallback ?? []), route]),
    };
  }

  const model = routeOptions.model;

  if (!model) {
    throw new Error("Custom LLM targets require an upstream model");
  }

  const route: LlmRoute = {
    provider: providerName,
    model,
  };
  const existingNonFallbackEntries = Object.entries(config.llm ?? {}).flatMap(([key, value]) =>
    key !== "fallback" && key !== target && value && !Array.isArray(value)
      ? ([[key, value]] as Array<[string, LlmRoute]>)
      : [],
  );

  return {
    ...config,
    providers: {
      ...(config.providers ?? {}),
      [providerName]: nextProvider,
    },
    llm: withFallbackLast([[target, route], ...existingNonFallbackEntries], config.llm?.fallback),
  };
};

export const removeLlmProvider = (
  config: FederationConfig,
  providerName: string,
): { config: FederationConfig; removed: boolean } => {
  const llm = config.llm;
  const { [providerName]: removedProvider, ...remainingProviders } = config.providers ?? {};

  if (!removedProvider) {
    return { config, removed: false };
  }

  const entries: Array<[string, LlmRoute | LlmFallbackRoute[]]> = Object.entries(llm ?? {}).flatMap(
    ([target, value]): Array<[string, LlmRoute | LlmFallbackRoute[]]> => {
    if (target === "fallback") {
      const fallback = (llm?.fallback ?? []).filter((route) => route.provider !== providerName);
      return fallback.length > 0 ? [["fallback", fallback]] : [];
    }

    if (!value || Array.isArray(value) || value.provider === providerName) {
      return [];
    }

    return [[target, value]];
    },
  );

  return {
    config: {
      ...config,
      providers: Object.keys(remainingProviders).length > 0 ? remainingProviders : undefined,
      llm: entries.length > 0
        ? withFallbackLast(
            entries.flatMap(([target, value]) =>
              target !== "fallback" && !Array.isArray(value) ? ([[target, value]] as Array<[string, LlmRoute]>) : [],
            ),
            entries.find(([target]) => target === "fallback")?.[1] as LlmFallbackRoute[] | undefined,
          )
        : undefined,
    },
    removed: true,
  };
};

export const addMcpServer = (
  config: FederationConfig,
  name: string,
  server: McpServerConfig,
): FederationConfig => {
  if (config.mcp?.[name]) {
    throw new Error(`MCP server already exists: ${name}`);
  }

  return {
    ...config,
    mcp: {
      ...(config.mcp ?? {}),
      [name]: server,
    },
  };
};

export const removeMcpServer = (
  config: FederationConfig,
  name: string,
): { config: FederationConfig; removed: boolean } => {
  const { [name]: removed, ...remaining } = config.mcp ?? {};

  if (!removed) {
    return { config, removed: false };
  }

  return {
    config: {
      ...config,
      mcp: Object.keys(remaining).length > 0 ? remaining : undefined,
    },
    removed: true,
  };
};
