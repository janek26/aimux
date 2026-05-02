import type { AimuxConfig, LlmFallbackRoute, LlmProvider } from "../config/types.js";
import { listLlmProviders, listLlmRoutes } from "../core/config.js";
import { assertProviderToken, resolveProvider, type ResolvedLlmProvider } from "./providers.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ChatRequest = {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  max_tokens?: number;
  [key: string]: unknown;
};

type ModelList = {
  data?: Array<{ id?: string }>;
};

export type LlmRoute = {
  target: "mapped" | "fallback";
  provider: ResolvedLlmProvider;
  model: string;
};

const jsonHeaders = { "content-type": "application/json" };

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const value = await request.json() as unknown;
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const contentTypeIsJson = (response: Response): boolean =>
  response.headers.get("content-type")?.toLowerCase().includes("json") ?? false;

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

const modelAllowedByRules = (route: LlmFallbackRoute, model: string): boolean => {
  if (route.model_whitelist) {
    return route.model_whitelist.includes(model);
  }

  return !(route.model_blacklist ?? []).includes(model);
};

const canServeModel = async (
  fetcher: FetchLike,
  resolved: ResolvedLlmProvider,
  route: LlmFallbackRoute,
  model: string,
): Promise<boolean> => {
  if (!modelAllowedByRules(route, model)) {
    return false;
  }

  if (route.model_whitelist) {
    return true;
  }

  if (resolved.schema === "anthropic") {
    return true;
  }

  try {
    const response = await fetcher(joinUrl(resolved.baseUrl, "/models"), {
      headers: authHeaders(resolved.provider, resolved.schema),
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as ModelList;
    const models = body.data?.flatMap((item) => (item.id ? [item.id] : [])) ?? [];

    return models.length === 0 || models.includes(model);
  } catch {
    return false;
  }
};

export const selectLlmRoute = async (
  config: AimuxConfig,
  requestedModel: string,
  fetcher: FetchLike = fetch,
): Promise<LlmRoute> => {
  const direct = listLlmRoutes(config).find(({ target }) => target === requestedModel);

  if (direct?.provider) {
    const provider = resolveProvider(direct.provider);
    assertProviderToken(direct.provider);
    return {
      target: "mapped",
      provider,
      model: direct.route.model ?? requestedModel,
    };
  }

  for (const route of config.llm?.fallback ?? []) {
    const provider = config.providers?.[route.provider];

    if (!provider) {
      continue;
    }

    const resolved = resolveProvider(provider);
    assertProviderToken(provider);

    if (await canServeModel(fetcher, resolved, route, requestedModel)) {
      return {
        target: "fallback",
        provider: resolved,
        model: requestedModel,
      };
    }
  }

  throw new Error(`No LLM provider can serve model: ${requestedModel}`);
};

const toOpenAiAnthropicResponse = (body: unknown, model: string): unknown => {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const anthropic = body as {
    id?: string;
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = anthropic.content?.find((content) => content.type === "text")?.text ?? "";

  return {
    id: anthropic.id ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: anthropic.stop_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: anthropic.usage?.input_tokens ?? 0,
      completion_tokens: anthropic.usage?.output_tokens ?? 0,
      total_tokens: (anthropic.usage?.input_tokens ?? 0) + (anthropic.usage?.output_tokens ?? 0),
    },
  };
};

const toAnthropicRequest = (request: ChatRequest, model: string): Record<string, unknown> => ({
  model,
  messages: request.messages ?? [],
  max_tokens: request.max_tokens ?? 1024,
  stream: request.stream ?? false,
  system: request.system,
});

export const proxyChatCompletion = async (
  config: AimuxConfig,
  request: ChatRequest,
  fetcher: FetchLike = fetch,
): Promise<Response> => {
  if (!request.model || typeof request.model !== "string") {
    return Response.json({ error: "Request must include a model string" }, { status: 400 });
  }

  const route = await selectLlmRoute(config, request.model, fetcher);
  const provider = route.provider.provider;

  if (route.provider.schema === "anthropic") {
    const upstream = await fetcher(joinUrl(route.provider.baseUrl, "/messages"), {
      method: "POST",
      headers: {
        ...jsonHeaders,
        ...authHeaders(provider, "anthropic"),
      },
      body: JSON.stringify(toAnthropicRequest(request, route.model)),
    });

    if (request.stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }

    if (!contentTypeIsJson(upstream)) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }

    const body = await upstream.json().catch(() => undefined);

    if (body === undefined) {
      return Response.json({ error: "Anthropic response was not valid JSON" }, { status: 502 });
    }

    return Response.json(toOpenAiAnthropicResponse(body, route.model), { status: upstream.status });
  }

  const upstream = await fetcher(joinUrl(route.provider.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      ...jsonHeaders,
      ...authHeaders(provider, "openai"),
    },
    body: JSON.stringify({
      ...request,
      model: route.model,
    }),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
};

export const listMuxedModels = async (
  config: AimuxConfig,
  fetcher: FetchLike = fetch,
): Promise<{ object: "list"; data: Array<{ id: string; object: "model"; owned_by: string }> }> => {
  const mappedModels = listLlmProviders(config)
    .filter(({ target }) => target !== "fallback")
    .map(({ target, providerName }) => ({
      id: target,
      object: "model" as const,
      owned_by: providerName,
    }));
  const fallbackModels = await Promise.all(
    (config.llm?.fallback ?? []).map(async (route) => {
      const provider = config.providers?.[route.provider];

      if (!provider) {
        return [];
      }

      const resolved = resolveProvider(provider);

      if (route.model_whitelist) {
        return route.model_whitelist.map((id) => ({
          id,
          object: "model" as const,
          owned_by: route.provider,
        }));
      }

      if (resolved.schema === "anthropic") {
        return [];
      }

      const response = await fetcher(joinUrl(resolved.baseUrl, "/models"), {
        headers: authHeaders(provider, resolved.schema),
      }).catch(() => undefined);

      if (!response?.ok) {
        return [];
      }

      const body = await response.json().catch(() => undefined) as ModelList | undefined;
      return (body?.data ?? []).flatMap((item) =>
        item.id
          ? [
              {
                id: item.id,
                object: "model" as const,
                owned_by: route.provider,
              },
            ]
          : [],
      );
    }),
  );

  return {
    object: "list",
    data: [...mappedModels, ...fallbackModels.flat()],
  };
};

export const createLlmHttpHandler =
  (config: AimuxConfig, fetcher: FetchLike = fetch) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json(await listMuxedModels(config, fetcher));
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await parseJsonObject(request);

      if (!body) {
        return Response.json({ error: "Request body must be a valid JSON object" }, { status: 400 });
      }

      return proxyChatCompletion(config, body as ChatRequest, fetcher);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
