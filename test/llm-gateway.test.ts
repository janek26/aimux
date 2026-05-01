import { describe, expect, test } from "bun:test";
import { createLlmHttpHandler, selectLlmRoute } from "../src/llm/gateway.js";
import type { FederationConfig } from "../src/config/types.js";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  Response.json(body, init);

describe("LLM gateway", () => {
  test("routes explicit model remaps to their configured provider model", async () => {
    const config: FederationConfig = {
      providers: {
        prod: {
          preset: "ollama",
        },
      },
      llm: {
        "custom/prod": {
          provider: "prod",
          model: "llama3",
        },
      },
    };

    const route = await selectLlmRoute(config, "custom/prod");

    expect(route.target).toBe("mapped");
    expect(route.model).toBe("llama3");
    expect(route.provider.provider.preset).toBe("ollama");
  });

  test("falls back to the first provider whose model list contains the requested model", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      calls.push(String(url));

      if (String(url).includes("one")) {
        return jsonResponse({ data: [{ id: "other-model" }] });
      }

      return jsonResponse({ data: [{ id: "target-model" }] });
    };
    const config: FederationConfig = {
      providers: {
        one: { schema: "openai", url: "https://one.example/v1" },
        two: { schema: "openai", url: "https://two.example/v1" },
      },
      llm: {
        fallback: [
          { provider: "one" },
          { provider: "two" },
        ],
      },
    };

    const route = await selectLlmRoute(config, "target-model", fetcher);

    expect(route.provider.provider.url).toBe("https://two.example/v1");
    expect(calls).toEqual(["https://one.example/v1/models", "https://two.example/v1/models"]);
  });

  test("proxies OpenAI-compatible streaming responses without buffering", async () => {
    const fetcher = async () =>
      new Response("data: chunk\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    const handler = createLlmHttpHandler(
      {
        providers: {
          prod: {
            schema: "openai",
            url: "https://llm.example/v1",
          },
        },
        llm: {
          "custom/prod": {
            provider: "prod",
            model: "gpt-5",
          },
        },
      },
      fetcher,
    );

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "custom/prod", stream: true, messages: [] }),
      }),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe("data: chunk\n\n");
  });

  test("passes OpenAI-compatible multimodal and tool-call requests through unchanged", async () => {
    let upstreamBody: unknown;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({
        id: "chatcmpl-tools",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: "{\"query\":\"weather\"}",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    };
    const handler = createLlmHttpHandler(
      {
        providers: {
          prod: {
            schema: "openai",
            url: "https://llm.example/v1",
          },
        },
        llm: {
          "custom/prod": {
            provider: "prod",
            model: "gpt-4o",
          },
        },
      },
      fetcher,
    );
    const requestBody = {
      model: "custom/prod",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
      stream: true,
    };

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );

    expect(upstreamBody).toEqual({
      ...requestBody,
      model: "gpt-4o",
    });
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "search",
                },
              },
            ],
          },
        },
      ],
    });
  });

  test("returns a clear error for invalid JSON request bodies", async () => {
    const handler = createLlmHttpHandler({});

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Request body must be a valid JSON object" });
  });

  test("preserves non-JSON Anthropic upstream responses", async () => {
    const fetcher = async () =>
      new Response("upstream auth error", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    const handler = createLlmHttpHandler(
      {
        providers: {
          anthropic: {
            schema: "anthropic",
            url: "https://api.anthropic.com/v1",
          },
        },
        llm: {
          "custom/claude": {
            provider: "anthropic",
            model: "claude-sonnet-4",
          },
        },
      },
      fetcher,
    );

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "custom/claude", messages: [] }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("upstream auth error");
  });
});
