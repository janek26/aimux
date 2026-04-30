# AI Federation

One config and one CLI for managing LLM endpoints and MCP servers, then re-exposing them as unified gateways.

## Quick Start

Install dependencies:

```sh
bun install
```

Create a config:

```sh
bun src/cli.ts init
```

In an interactive terminal this asks whether to create `.mcp-federation.yml` in the current directory or in your home directory. The config starts empty, so no local provider such as Ollama is assumed.

Add an OpenAI-compatible LLM provider:

```sh
bun src/cli.ts llm add fallback \
  --name openai \
  --preset openai \
  --token "$OPENAI_API_KEY"
```

This creates a top-level provider named `openai` and adds it to `llm.fallback`.

Run both the LLM gateway and MCP Streamable HTTP endpoint:

```sh
bun src/cli.ts serve --port 8787
```

Generate local client config for tools that can connect to the gateway:

```sh
bun src/cli.ts generate all
```

This writes supported tool config into the current directory. Targets include `opencode`, `cursor`, `zed`, `claude-code`, `codex`, and `gemini-cli`. If a tool cannot configure the LLM endpoint from project-local config, AI Federation logs that and still writes MCP config when supported.

Use it like an OpenAI-compatible API:

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

`serve` prints the LLM base URL, model/chat URLs, MCP Streamable HTTP URL, and the stdio command to configure in MCP clients. `serve mcp` writes setup details to stderr so stdout remains reserved for the MCP protocol. OAuth refreshes update `.mcp-federation.yml`; pass `--frozen` to `serve` or `serve mcp` to keep the config file unchanged.

Interactive `mcp add` can fetch available MCP tools/prompts and let you choose a whitelist or blacklist before writing config. You can also provide filters or renames with flags:

```sh
bun src/cli.ts mcp add hugging-face https://huggingface.co/mcp \
  --transport http \
  --header "Authorization=Bearer $HF_TOKEN" \
  --method-whitelist model_search \
  --method-renames model_search:hf_model_search
```

`mcp add` validates the server before writing the config. For remote MCP servers, interactive mode first uses the standard MCP OAuth flow: it lets the SDK discover auth metadata, prints the authorization URL when OAuth is required, starts a temporary localhost callback, exchanges the auth code, and stores only the OAuth credentials needed for future requests in `.mcp-federation.yml` (`access_token`, `token_type`, and, when issued, `refresh_token` plus the issued `client_id`/secret needed to refresh). If OAuth is not available, the CLI offers bearer-token or custom-header setup. You can also pass a static header up front, such as `--header "Authorization=Bearer $TOKEN"`.

Run setup any time to validate the whole config, including live LLM/MCP preflight checks:

```sh
bun src/cli.ts setup
```

`config validate` is an alias for the same full validation flow.

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

## Build A Binary

```sh
bun run build
./ai-fed help
```

After building, use `./ai-fed` instead of `bun src/cli.ts`.

## Config

AI Federation stores settings in `.mcp-federation.yml`. The CLI searches from the current directory upward and uses the closest config file.

Example:

```yaml
providers:
  openai-prod:
    preset: openai
    token: sk-...
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
  remote-oauth:
    transport: http
    url: https://mcp.example.com/mcp
    oauth:
      access_token: mcp_access_token
      refresh_token: mcp_refresh_token
      token_type: Bearer
      client_id: issued-client-id
```

## Development

```sh
bun run typecheck
bun test
```

The e2e tests run the real CLI in isolated temp directories with fake LLM and MCP servers.
