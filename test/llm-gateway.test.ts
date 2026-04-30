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

    const route = await selectLlmRoute(config, "target-model", fetcher as unknown as typeof fetch);

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
      fetcher as unknown as typeof fetch,
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
});
