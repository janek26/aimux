import type { LlmPreset, LlmProvider, LlmSchema } from "../config/types.js";

export type LlmPresetDefinition = {
  schema: LlmSchema;
  baseUrl: string;
  tokenRequired: boolean;
};

export const LLM_PROVIDER_PRESETS: Record<LlmPreset, LlmPresetDefinition> = {
  openai: {
    schema: "openai",
    baseUrl: "https://api.openai.com/v1",
    tokenRequired: true,
  },
  anthropic: {
    schema: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    tokenRequired: true,
  },
  google: {
    schema: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    tokenRequired: true,
  },
  mistral: {
    schema: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    tokenRequired: true,
  },
  groq: {
    schema: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    tokenRequired: true,
  },
  ollama: {
    schema: "openai",
    baseUrl: "http://localhost:11434/v1",
    tokenRequired: false,
  },
  openrouter: {
    schema: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    tokenRequired: true,
  },
  fireworks: {
    schema: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    tokenRequired: true,
  },
};

export type ResolvedLlmProvider = {
  provider: LlmProvider;
  schema: LlmSchema;
  baseUrl: string;
};

export const resolveProvider = (provider: LlmProvider): ResolvedLlmProvider => {
  if (provider.preset) {
    const preset = LLM_PROVIDER_PRESETS[provider.preset];

    return {
      provider,
      schema: provider.schema ?? preset.schema,
      baseUrl: provider.url ?? preset.baseUrl,
    };
  }

  if (!provider.schema || !provider.url) {
    throw new Error("Provider must define either preset or schema and url");
  }

  return {
    provider,
    schema: provider.schema,
    baseUrl: provider.url,
  };
};

export const assertProviderToken = (provider: LlmProvider): void => {
  if (!provider.preset) {
    return;
  }

  const preset = LLM_PROVIDER_PRESETS[provider.preset];

  if (preset.tokenRequired && !provider.token) {
    throw new Error("Provider requires a token");
  }
};
