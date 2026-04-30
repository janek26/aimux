import { registerSchema, validate } from "@hyperjump/json-schema/draft-2020-12";
import type { SchemaObject } from "@hyperjump/json-schema/draft-2020-12";
import type { Json } from "@hyperjump/json-pointer";
import configSchemaJson from "./config.schema.json";
import type { ConfigValidatorPort, FederationConfig, ValidationResult } from "./types.js";

type ConfigSchema = SchemaObject & { $id: string };
type ValidateConfig = Awaited<ReturnType<typeof validate>>;
type OutputUnit = {
  keyword: string;
  absoluteKeywordLocation: string;
  instanceLocation: string;
  errors?: OutputUnit[];
};

const configSchema = configSchemaJson as unknown as ConfigSchema;
let compiledValidator: ValidateConfig | undefined;

const flattenErrors = (errors: OutputUnit[] = []): OutputUnit[] =>
  errors.flatMap((error) => error.errors && error.errors.length > 0 ? flattenErrors(error.errors) : [error]);

const formatErrors = (errors: unknown): string[] => {
  const flattened = flattenErrors(Array.isArray(errors) ? errors as OutputUnit[] : []);

  if (flattened.length === 0) {
    return ["Config failed schema validation"];
  }

  return flattened.map((error) => {
    const path = error.instanceLocation || "/";
    const keyword = error.absoluteKeywordLocation.split("/").at(-1) ?? error.keyword;

    return `Config schema validation failed at ${path}: ${keyword}`;
  });
};

const collectUnknownProviderReferences = (config: FederationConfig): string[] => {
  const llm = config.llm ?? {};
  const providerNames = new Set(Object.keys(config.providers ?? {}));
  const routeProviders = Object.entries(llm)
    .filter(([key]) => key !== "fallback")
    .map(([, provider]) => provider)
    .filter((provider): provider is { provider: string } => {
      return typeof provider === "object" && provider !== null && "provider" in provider;
    })
    .map((provider) => provider.provider);
  const fallbackProviders = (llm.fallback ?? []).map((route) => route.provider);

  return [...routeProviders, ...fallbackProviders].filter((name) => !providerNames.has(name));
};

const duplicateValues = (values: string[]): string[] => {
  const counts = values.reduce<Record<string, number>>(
    (acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }),
    {},
  );

  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([value]) => value);
};

export class HyperjumpConfigValidator implements ConfigValidatorPort {
  private compiled?: ValidateConfig;

  async validate(config: FederationConfig): Promise<ValidationResult> {
    const validateConfig = await this.getValidator();
    const schemaResult = validateConfig(config as unknown as Json, "DETAILED");
    const unknownProviderReferences = [...new Set(collectUnknownProviderReferences(config))];
    const duplicateMcpNames = duplicateValues(Object.keys(config.mcp ?? {}));

    const errors = [
      ...(schemaResult.valid ? [] : formatErrors(schemaResult.errors)),
      ...unknownProviderReferences.map((name) => `Unknown LLM provider reference: ${name}`),
      ...duplicateMcpNames.map((name) => `Duplicate MCP server name: ${name}`),
    ];

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async assertValid(config: FederationConfig): Promise<void> {
    const result = await this.validate(config);

    if (!result.valid) {
      throw new Error(result.errors.join("\n"));
    }
  }

  private async getValidator(): Promise<ValidateConfig> {
    if (compiledValidator) {
      this.compiled = compiledValidator;
      return compiledValidator;
    }

    try {
      registerSchema(configSchema);
    } catch (error) {
      if (!String(error).includes("already been registered")) {
        throw error;
      }
    }

    compiledValidator = await validate(configSchema.$id);
    this.compiled = compiledValidator;
    return this.compiled;
  }
}
