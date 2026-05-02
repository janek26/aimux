# AIMux

> "With xAI, OpenAI, Anthropic's models updating regularly, do I have to keep changing the 'model'=>'gpt-4-1-fast-non-reasoning' name for example in my code on ALL my sites for the next 100 years?
>
> Or can I just say 'model'=> use best or something?
>
> And no I don't wanna use OpenRouter, I just wanna use whatever is the best but affordable model
>
> There's so many places in my code on so many of my sites where I have to change this and they do deprecate models regularly so it's like breaking changes" — [@levelsio](https://x.com/levelsio/status/2050244383845318786)

AI tools all want their own provider config, model names, MCP servers, and local files. AIMux keeps that moving target in one config and exposes it as one local gateway: OpenAI-compatible `/v1` for models, plus one muxed MCP endpoint for tools.

Use the same local AI stack across Cursor, Zed, Claude Code, Codex, Gemini CLI, OpenCode, and anything else that speaks OpenAI or MCP.

## Features

- One `.aimux.yml` for providers, model routes, and MCP servers.
- One OpenAI-compatible gateway at `/v1/models` and `/v1/chat/completions`.
- One MCP gateway that muxes tools, prompts, and resources from many servers.
- Client config generation for common AI coding tools.
- User service management for macOS LaunchAgent and Linux systemd.

## Quick Start

```sh
bun install
bun src/cli.ts init
bun src/cli.ts llm add fallback --name openai --preset openai --token "$OPENAI_API_KEY"
bun src/cli.ts serve --port 8787
```

Then use AIMux like an OpenAI-compatible API:

```sh
curl http://localhost:8787/v1/models

curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

`init` creates `.aimux.yml`. Config lookup walks up from the current directory, then falls back to `~/.aimux.yml`.

## MCP

```sh
bun src/cli.ts mcp add github \
  --transport stdio \
  --command npx \
  --args "-y,@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN"

bun src/cli.ts serve mcp
```

Remote MCP servers can use OAuth, bearer tokens, custom headers, method filters, and method renames.

## Client Config

```sh
bun src/cli.ts generate all
```

Targets: `opencode`, `cursor`, `zed`, `claude-code`, `codex`, and `gemini-cli`.

Generated client config is local machine state and is ignored by git. Zed currently reads `language_models` only from `~/.config/zed/settings.json`; AIMux writes project-local Zed MCP config and asks before updating global Zed model settings.

## Service

```sh
aimux service enable
aimux service logs
aimux service load ./path/to/.aimux.yml
aimux service restart
aimux service disable
aimux service uninstall
```

The service runs `aimux serve` against `~/.aimux.yml`. Logs go to `~/Library/Logs/aimux/aimux.log` on macOS and `~/.local/state/aimux/aimux.log` on Linux.

## Config

Do not commit real `.aimux.yml` files. They can contain API keys, MCP headers, OAuth access tokens, and refresh tokens. Use `.aimux.example.yml` as a safe starting point.

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
  local-files:
    transport: stdio
    command: mcp-server-filesystem
    args: ["."]
```

## Compatibility

OpenAI-compatible providers are proxied without rewriting request or response bodies except for configured model remapping. Streaming, tool calls, structured outputs, image inputs, and provider-specific fields pass through when the upstream supports them.

Anthropic providers are adapted through the Messages API for basic chat-completion compatibility. Full Anthropic multimodal and tool-use normalization is future work.

## Development

```sh
bun install
bun run check
bun run build
```

See `docs/PROJECT.md` for architecture notes.

## License

MIT
