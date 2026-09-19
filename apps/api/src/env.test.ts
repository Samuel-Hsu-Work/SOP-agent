import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "./env.ts";

describe("loadConfig", () => {
  it("applies defaults when only the API key is set", () => {
    expect(loadConfig({ OPENAI_API_KEY: "key" })).toEqual({
      openAiApiKey: "key",
      host: "127.0.0.1",
      port: 4000,
      webOrigin: "http://localhost:3000",
      logLevel: "info",
      models: ["gpt-5.6-sol", "gpt-5.6-luna"],
    });
  });

  it("reads overrides", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "key",
      API_HOST: "0.0.0.0",
      PORT: "5005",
      WEB_ORIGIN: "https://app.example.com",
      LOG_LEVEL: "warn",
      LLM_MODEL: "primary",
      LLM_FALLBACK_MODEL: "fallback",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 5005,
      webOrigin: "https://app.example.com",
      logLevel: "warn",
      models: ["primary", "fallback"],
    });
  });

  it("fails fast with a clear English message when the API key is missing or empty", () => {
    for (const environment of [{}, { OPENAI_API_KEY: "" }]) {
      expect(() => loadConfig(environment)).toThrow(ConfigurationError);
      expect(() => loadConfig(environment)).toThrow(/OPENAI_API_KEY: Missing/);
    }
  });

  it("rejects an invalid port and an invalid origin", () => {
    expect(() => loadConfig({ OPENAI_API_KEY: "key", PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ OPENAI_API_KEY: "key", WEB_ORIGIN: "not a url" })).toThrow(
      /WEB_ORIGIN/,
    );
  });
});
