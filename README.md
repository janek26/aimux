# AI Federation

One config and one Bun CLI for managing LLM providers and MCP servers, then exposing them as local gateways that AI tools can share.

AI Federation is useful when you want:

- One OpenAI-compatible `/v1` endpoint backed by multiple upstream providers.
- One MCP server that federates tools, prompts, and resources from many MCP servers.
- Generated local config for tools such as OpenCode, Cursor, Zed, Claude Code, Codex, and Gemini CLI.
- A project-local or home-level config that can be validated before it is used.

## Quick Start

```sh
bun install
bun src/cli.ts init
```

`init` creates an empty `.mcp-federation.yml`. In an interactive terminal it asks whether to create the file in the current project or in your home directory. The CLI searches from the current directory upward and uses the closest config file, then falls back to `~/.mcp-federation.yml`.

Add an OpenAI-compatible provider to the fallback route:

```sh
bun src/cli.ts llm add fallback \
  --name openai \
  --preset openai \
  --token "$OPENAI_API_KEY"
```

Run the combined LLM and MCP gateway:

```sh
bun src/cli.ts serve --port 8787
```

Use the LLM gateway like an OpenAI-compatible API:

```sh
curl http://localhost:8787/v1/models
```

```sh
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

For OpenAI-compatible providers, AI Federation forwards chat-completion request and response bodies without rewriting them except for configured model remapping. That means provider-supported streaming, tool calls, structured outputs, image inputs, and other OpenAI-compatible fields pass through to the upstream provider.

Anthropic providers are adapted through the Messages API for basic chat-completion compatibility. Non-streaming text responses are normalized back to OpenAI-compatible responses, and streaming responses are proxied as returned by Anthropic. Full Anthropic multimodal and tool-use normalization is not claimed yet.

## MCP Quick Start

Add an MCP server:

```sh
bun src/cli.ts mcp add github \
  --transport stdio \
  --command npx \
  --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN"
```

Expose all configured MCP servers as one stdio MCP server:

```sh
bun src/cli.ts serve mcp
```

`serve` prints the LLM base URL, model/chat URLs, MCP Streamable HTTP URL, and the stdio command to configure in MCP clients. `serve mcp` writes setup details to stderr so stdout remains reserved for the MCP protocol.

Interactive `mcp add` validates a server before writing it to config. For remote MCP servers, it can run the standard MCP OAuth flow, start a temporary localhost callback, exchange the auth code, and persist only the credentials needed for future requests. If OAuth is not available, the CLI offers bearer-token or custom-header setup.

You can also provide method filters or renames with flags:

```sh
bun src/cli.ts mcp add hugging-face https://huggingface.co/mcp \
  --transport http \
  --header "Authorization=Bearer $HF_TOKEN" \
  --method-whitelist model_search \
  --method-renames model_search:hf_model_search
```

## Client Config Generation

Generate local client config for supported tools:

```sh
bun src/cli.ts generate all
```

Targets include `opencode`, `cursor`, `zed`, `claude-code`, `codex`, and `gemini-cli`. Some tools cannot configure an LLM endpoint from project-local config; AI Federation logs that limitation and still writes MCP config when supported.

Generated client config is intentionally ignored by git because it is local machine state.

## Common Commands

```sh
bun src/cli.ts setup
bun src/cli.ts config path
bun src/cli.ts config validate
bun src/cli.ts generate all
bun src/cli.ts llm list
bun src/cli.ts llm remove <provider-name>
bun src/cli.ts mcp list
bun src/cli.ts mcp remove <server-name>
```

`setup` and `config validate` run schema validation plus live LLM/MCP preflight checks. OAuth refreshes update `.mcp-federation.yml`; pass `--frozen` to `serve` or `serve mcp` to keep the config file unchanged.

## Configuration

AI Federation stores settings in `.mcp-federation.yml` or `.mcp-federation.yaml`.

Do not commit real config files. They can contain API keys, MCP headers, OAuth access tokens, and refresh tokens. Use `.mcp-federation.example.yml` as a safe starting point.

```yaml
providers:
  openai-prod:
    preset: openai
    token: <OPENAI_API_KEY>
  local-ollama:
    preset: ollama

llm:
  custom/prod:
    provider: openai-prod
    model: gpt-4o
  fallback:
    - provider: local-ollama

mcp:
  local-files:
    transport: stdio
    command: mcp-server-filesystem
    args: ["."]
    method_blacklist: ["delete_file"]
```

## Architecture

The CLI is intentionally small and split by responsibility:

- `src/cli.ts` handles argument parsing, prompts, command orchestration, and local client config generation.
- `src/config` owns config types, schema validation, and YAML repository behavior.
- `src/core` contains pure config transforms such as add/remove/list operations.
- `src/llm` resolves provider presets and proxies OpenAI-compatible chat/model requests.
- `src/mcp` creates MCP clients, applies method controls, handles OAuth persistence, and exposes the federated server.

See `docs/PROJECT.md` for the project architecture and implementation notes.

## Development

```sh
bun install
bun run typecheck
bun test
bun run check
```

Build a local binary:

```sh
bun run build
./ai-fed help
```

The e2e tests run the real CLI in isolated temp directories with fake LLM and MCP servers.

## Contributing

Issues and pull requests are welcome. Please read `CONTRIBUTING.md` and run `bun run check` before opening a PR.

## License

MIT
