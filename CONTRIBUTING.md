# Contributing

Thanks for helping improve AI Federation.

## Development

```sh
bun install
bun run check
```

`bun run check` runs TypeScript and the full Bun test suite. The e2e tests run the real CLI in isolated temp directories with fake LLM and MCP servers.

## Pull Requests

- Keep changes focused and explain the user-facing behavior they affect.
- Add or update tests for CLI behavior, config schema changes, LLM routing, MCP federation, and OAuth persistence.
- Update `README.md` when commands, config shape, or supported integrations change.
- Update `docs/PROJECT.md` when module boundaries or architecture decisions change.
- Do not commit `.mcp-federation.yml`, generated client config, build output, or secrets.

## Local Config

Use `.mcp-federation.example.yml` as a template for local testing:

```sh
cp .mcp-federation.example.yml .mcp-federation.yml
```

Replace placeholder values locally. Real config files are ignored by git because they may contain provider tokens, MCP headers, and OAuth credentials.
