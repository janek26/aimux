# Project Architecture

AI Federation is a local control plane for AI tooling. It keeps provider and MCP server configuration in one YAML file, validates it, and exposes two gateway surfaces:

- An OpenAI-compatible LLM gateway at `/v1/models` and `/v1/chat/completions`.
- A federated MCP gateway over Streamable HTTP or stdio.

The project is intentionally a Bun-first TypeScript CLI. The code favors small modules with explicit data flow over framework abstractions.

## Design Goals

- Make one local endpoint usable by many AI tools.
- Keep provider definitions single-sourced under `providers`.
- Keep route config declarative and easy to review.
- Validate configuration before persisting changes that depend on live services.
- Persist only long-lived credentials required to run later.
- Keep generated client config and local credentials out of git.

## Config Model

The CLI reads `.mcp-federation.yml` or `.mcp-federation.yaml`. Lookup starts in the current directory, walks upward, and finally checks the user's home directory.

The config has three top-level sections:

```yaml
providers:
  openai-prod:
    preset: openai
    token: <OPENAI_API_KEY>

llm:
  custom/prod:
    provider: openai-prod
    model: gpt-4o
  fallback:
    - provider: openai-prod

mcp:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
```

`providers` contains reusable LLM provider definitions. `llm` maps public model names to providers or defines fallback routes. `mcp` contains upstream MCP servers plus optional method controls.

## LLM Gateway

LLM providers can be configured from presets or explicit schemas:

```sh
ai-fed llm add fallback --name openai --preset openai --token "$OPENAI_API_KEY"
ai-fed llm add custom/prod --name openai --model gpt-4o
```

Preset providers resolve to a schema and base URL in `src/llm/providers.ts`. Custom providers must specify a schema and URL.

Routing behavior:

- Direct model routes such as `custom/prod` call the configured provider and upstream model.
- Fallback routes try providers in order until a provider can serve the requested model.
- `model_whitelist` allows a fallback provider to accept known models without probing `/models`.
- `model_blacklist` prevents a fallback provider from receiving selected models.
- OpenAI-compatible responses and streaming bodies are proxied without buffering.
- OpenAI-compatible multimodal, tool-call, structured-output, and provider-specific fields are passed through unchanged except for model remapping.
- Anthropic requests are adapted through the Messages API and normalized back into OpenAI-compatible non-streaming text responses.
- Anthropic streaming is proxied as returned by Anthropic; full Anthropic multimodal and tool-use normalization is future work.

## MCP Gateway

MCP servers can use `stdio`, `http`, or `sse` transports:

```sh
ai-fed mcp add github \
  --transport stdio \
  --command npx \
  --args "-y,@modelcontextprotocol/server-github"
```

Remote MCP servers can use static headers or OAuth. During interactive setup, the CLI attempts MCP OAuth first, then falls back to manual bearer-token or custom-header setup when needed.

Persisted OAuth data is deliberately minimal:

- `access_token`
- `token_type`
- `refresh_token` when issued
- issued client metadata required for refresh

Runtime-only details such as redirect URLs, PKCE verifier state, discovery cache, and temporary callback server state are not persisted.

Method controls are applied per upstream server:

- `method_whitelist` exposes only selected tools/prompts.
- `method_blacklist` hides selected tools/prompts.
- `method_renames` changes the exposed names.
- Name collisions are resolved by prefixing the duplicate with the upstream server name.

## Module Boundaries

- `src/cli.ts` parses commands, runs prompts, coordinates validation, and writes generated client config.
- `src/config/types.ts` defines the public config shape.
- `src/config/config.schema.json` is the machine-readable schema used by validation and tests.
- `src/config/repository.ts` owns YAML loading, lookup, and writes.
- `src/config/validation.ts` combines JSON Schema validation with cross-reference checks.
- `src/core/config.ts` contains pure config transforms.
- `src/llm` contains provider resolution, preflight checks, and HTTP proxy behavior.
- `src/mcp` contains MCP client creation, OAuth persistence, method federation, and server adapters.
- `test` covers schema rules, pure transforms, CLI flows, LLM behavior, MCP behavior, OAuth, and end-to-end CLI execution.

## Release Checklist

Before publishing a release:

```sh
bun install
bun run check
bun run build
```

Also verify that no local config or generated client config is staged:

```sh
git status --short
```

The files `.mcp-federation.yml`, `opencode.json`, `.cursor/mcp.json`, `.zed/settings.json`, `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, and `ai-fed` are ignored because they are local state or build output.
