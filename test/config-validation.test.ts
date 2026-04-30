import { describe, expect, test } from "bun:test";
import { HyperjumpConfigValidator } from "../src/config/validation.js";

describe("config validation", () => {
  test("rejects LLM routes that reference unknown providers", async () => {
    const result = await new HyperjumpConfigValidator().validate({
      llm: {
        "custom/prod": {
          provider: "missing",
          model: "gpt-4o",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unknown LLM provider reference: missing");
  });

  test("reports schema validation paths", async () => {
    const result = await new HyperjumpConfigValidator().validate({
      mcp: {
        openbnb: {
          transport: "http",
          url: "https://mcp.openbnb.ai/mcp",
          oauth: {
            access_token: "token",
            token_type: "Bearer",
            refresh_token: "refresh",
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("/mcp/openbnb/oauth");
    expect(result.errors.join("\n")).toContain("dependentRequired");
  });
});
