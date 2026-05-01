import type { LlmFallbackRoute, LlmProvider, LlmRoute } from "../config/types.js";
import { assertProviderToken, resolveProvider, type ResolvedLlmProvider } from "./providers.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ModelList = {
  data?: Array<{ id?: string }>;
};

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const authHeaders = (provider: LlmProvider, schema = resolveProvider(provider).schema): HeadersInit => {
  if (!provider.token) {
    return {};
  }

  return schema === "anthropic"
    ? {
        "x-api-key": provider.token,
        "anthropic-version": "2023-06-01",
      }
    : { authorization: `Bearer ${provider.token}` };
};

const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), 10_000);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const listProviderModels = async (
  providerName: string,
  resolved: ResolvedLlmProvider,
  fetcher: FetchLike,
): Promise<string[]> => {
  const url = joinUrl(resolved.baseUrl, "/models");
  const response = await withTimeout(
    fetcher(url, {
      headers: authHeaders(resolved.provider, resolved.schema),
    }),
    `Timed out validating LLM provider ${providerName}`,
  ).catch((error) => {
    throw new Error(`Could not reach LLM provider ${providerName}: ${String(error)}`);
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`LLM provider ${providerName} authentication failed`);
  }

  if (!response.ok) {
    throw new Error(`LLM provider ${providerName} validation failed: /models returned ${response.status}`);
  }

  const body = (await response.json()) as ModelList;
  return body.data?.flatMap((model) => (model.id ? [model.id] : [])) ?? [];
};

export const validateLlmProviderRoute = async (
  providerName: string,
  provider: LlmProvider,
  route: LlmRoute | LlmFallbackRoute,
  fetcher: FetchLike = fetch,
): Promise<void> => {
  assertProviderToken(provider);
  const resolved = resolveProvider(provider);
  const models = await listProviderModels(providerName, resolved, fetcher);
  const requestedModels = [
    ...("model" in route && route.model ? [route.model] : []),
    ...("model_whitelist" in route ? (route.model_whitelist ?? []) : []),
  ];

  if (models.length === 0 || requestedModels.length === 0) {
    return;
  }

  const missingModels = requestedModels.filter((model) => !models.includes(model));

  if (missingModels.length > 0) {
    throw new Error(
      `LLM provider ${providerName} does not expose model${missingModels.length === 1 ? "" : "s"}: ${missingModels.join(", ")}`,
    );
  }
};
