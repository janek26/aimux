# AI federation

Goal is to have a one stop shop to manage LLM endpoints and MCP servers and credentials or authentication. And reexpose it as a unified endpoint. You can find more details in the LLM and MCP sections

## Config

Everything gets stored in a shareable .mcp-federation.yml
It should be global (in user home dir) or in the project, the program should always use the closest config file going up, if non gets detected, it should ask where to create one (current dir or user dir)

## LLM

It should be easy to add and remove LLM endpoints. Either by specifing the schema (OpenAI compatible, Antropic compatible etc) and providing endpoint and token or by selecting from an existing list (create it with the most common providers) and providing token. Token can be optional by provider, ie local providers dont need it.

The cli command to add this should ie look like:

```
ai-fed llm add
```

this would guide the user through an cli flow to edit the config like

```
providers:
  added-provider:
    preset: openai
    token: apikey
  added-provider-2:
    preset: openai
    token: apikey
  custom-provider:
    schema: openai
    url: <url>
    token: apikey

llm:
  custom/prod: # allows for remapping a model too
    provider: added-provider
    model: gpt5
  fallback: # fallback passes provided models through
    - provider: added-provider-2
    - provider: custom-provider
      model_whitelist: ["deepseek-v4"] # allow optional whitelist OR model_blacklist, not prompted for
```

It should be possible to skip part or all of the interactive cli when providing the arguments like

```
ai-fed llm add fallback --name added-provider --preset openai --token apikey
```

Because of unique names, removing is as easy as 

```
ai-fed llm remove added-provider-2
```

Calling the service with the above config now should fallback for unknown models to the providers, until the first provider has that model.
Calling the service with a custom model from the config (like custom/prod in this case) should call the specified provider and model.
Provider definitions are stored once under `providers` and LLM routes only reference them by name. Removing a provider also removes routes that reference it.

We need to make sure the common llm endpoint standards are supported, like http streaming and all that. It should not feel different from using the underlying provider directly.

## MCP

It should be easy to add and remove MCP servers and expose them as one MCP server, similar to the LLM endpoint. Adding an MCP can require authentication, in which case the cli should guide the user through it and only store the resulting auth data in the config. OAuth config should keep the access token and token type, plus refresh token and issued client id/secret when provided and needed for refresh; runtime details like redirect URLs, PKCE verifier, discovery cache, and client metadata should not be persisted.

The cli command to add this should ie look like:

```
ai-fed mcp add
```

this would guide the user through an cli flow to edit the config like

```
mcp:
  hugging-face:
    transport: http
    url: https://huggingface.co/mcp
    headers:
      Authorization: Bearer hf_token
    method_whitelist: ["model_search"]
    method_renames:
      model_search: hf_model_search
  linear:
    transport: sse
    url: https://mcp.linear.app/sse
    headers:
      Authorization: Bearer linear_token
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: gh_token
  local-files:
    transport: stdio
    command: mcp-server-filesystem
    args: ["."]
    method_blacklist: ["delete_file"]
```

It should be possible to skip part or all of the interactive cli when providing the arguments like

```
ai-fed mcp add --transport http hugging-face https://huggingface.co/mcp
```

Because of unique names, removing is as easy as

```
ai-fed mcp remove github
```

Calling the exposed MCP server should list and call methods from all configured MCP servers. It should be possible to rename methods and select optional method_whitelist OR method_blacklist per server in the interactive cli.

## Stack

Everything should be done with typescript and bun as the runtime. This makes it super easy to ship as one binary. For CLI things it should use @clack/prompts and bun buildins. Also bun for tests. For config use cosmiconfig.
