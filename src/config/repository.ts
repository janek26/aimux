import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { cosmiconfig } from "cosmiconfig";
import YAML from "yaml";
import {
  CONFIG_FILE_NAME,
  CONFIG_FILE_NAMES,
  type ConfigLocation,
  type ConfigRepositoryPort,
  type ConfigValidatorPort,
  type FederationConfig,
} from "./types.js";

const explorer = cosmiconfig("mcp-federation", {
  searchPlaces: [...CONFIG_FILE_NAMES],
});

const fileExists = async (path: string): Promise<boolean> => Bun.file(path).exists();

const candidatePaths = (startDir: string): string[] => {
  const walk = (dir: string, seen: string[] = []): string[] => {
    const candidates = CONFIG_FILE_NAMES.map((fileName) => join(dir, fileName));
    const parent = dirname(dir);
    const nextSeen = [...seen, ...candidates];

    return parent === dir ? nextSeen : walk(parent, nextSeen);
  };

  return walk(resolve(startDir));
};

const normalizeConfig = (value: unknown): FederationConfig => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as FederationConfig;
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

export class YamlConfigRepository implements ConfigRepositoryPort {
  constructor(
    private readonly validator?: ConfigValidatorPort,
    private readonly homeDir = homedir(),
  ) {}

  async findConfigPath(startDir = process.cwd()): Promise<string | undefined> {
    for (const path of candidatePaths(startDir)) {
      if (await fileExists(path)) {
        return path;
      }
    }

    const homePath = join(this.homeDir, CONFIG_FILE_NAME);
    return (await fileExists(homePath)) ? homePath : undefined;
  }

  async read(path?: string): Promise<ConfigLocation | undefined> {
    const configPath = path ?? (await this.findConfigPath());

    if (!configPath) {
      return undefined;
    }

    explorer.clearLoadCache();
    const result = await explorer.load(configPath);
    const config = normalizeConfig(result?.config);

    if (this.validator) {
      await this.validator.assertValid(config);
    }

    return {
      path: configPath,
      config,
    };
  }

  async write(path: string, config: FederationConfig): Promise<void> {
    const cleanConfig = stripUndefined(config) as FederationConfig;

    if (this.validator) {
      await this.validator.assertValid(cleanConfig);
    }

    await Bun.write(path, YAML.stringify(cleanConfig, { indent: 2 }));
    explorer.clearLoadCache();
  }

  getDefaultProjectPath(startDir = process.cwd()): string {
    return join(resolve(startDir), CONFIG_FILE_NAME);
  }

  getDefaultHomePath(): string {
    return join(this.homeDir, CONFIG_FILE_NAME);
  }
}
