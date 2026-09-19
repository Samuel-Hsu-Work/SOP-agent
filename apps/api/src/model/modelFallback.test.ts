import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_PRIMARY_MODEL,
  ModelOutputError,
  ModelRefusalError,
  readModelsFromEnvironment,
  runWithModelFallback,
} from "./modelFallback.ts";

const models = ["primary-model", "fallback-model"];

describe("runWithModelFallback", () => {
  it("uses the primary model and never calls the fallback when it succeeds", async () => {
    const attempt = vi.fn(async (model: string) => `answer from ${model}`);

    const result = await runWithModelFallback(models, attempt);

    expect(result).toEqual({
      value: "answer from primary-model",
      servedByModel: "primary-model",
      failedAttempts: [],
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("falls back after a refusal and records why the primary failed", async () => {
    const attempt = vi.fn(async (model: string) => {
      if (model === "primary-model") throw new ModelRefusalError("cannot help with that");
      return "fallback answer";
    });

    const result = await runWithModelFallback(models, attempt);

    expect(result.servedByModel).toBe("fallback-model");
    expect(result.value).toBe("fallback answer");
    expect(result.failedAttempts).toEqual([
      { model: "primary-model", reason: "cannot help with that" },
    ]);
  });

  it("falls back after unusable structured output", async () => {
    const attempt = async (model: string) => {
      if (model === "primary-model") throw new ModelOutputError("did not match the schema");
      return "ok";
    };

    const result = await runWithModelFallback(models, attempt);

    expect(result.servedByModel).toBe("fallback-model");
  });

  it("falls back when the primary model is unavailable", async () => {
    const attempt = async (model: string) => {
      if (model === "primary-model") {
        throw new OpenAI.NotFoundError(404, {}, "model not found", new Headers());
      }
      return "ok";
    };

    const result = await runWithModelFallback(models, attempt);

    expect(result.servedByModel).toBe("fallback-model");
  });

  it("does not fall back on bad credentials, since another model cannot fix them", async () => {
    const attempt = vi.fn(async () => {
      throw new OpenAI.AuthenticationError(401, {}, "bad key", new Headers());
    });

    await expect(runWithModelFallback(models, attempt)).rejects.toBeInstanceOf(
      OpenAI.AuthenticationError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on errors that are not model or API failures", async () => {
    const attempt = vi.fn(async () => {
      throw new TypeError("a bug in our own code");
    });

    await expect(runWithModelFallback(models, attempt)).rejects.toBeInstanceOf(TypeError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when every model fails", async () => {
    const attempt = async (model: string) => {
      throw new ModelRefusalError(`${model} refused`);
    };

    await expect(runWithModelFallback(models, attempt)).rejects.toThrow("fallback-model refused");
  });
});

describe("readModelsFromEnvironment", () => {
  it("defaults to gpt-5.6-sol with gpt-5.6-luna as the fallback", () => {
    expect(readModelsFromEnvironment({})).toEqual([DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
    expect(DEFAULT_PRIMARY_MODEL).toBe("gpt-5.6-sol");
    expect(DEFAULT_FALLBACK_MODEL).toBe("gpt-5.6-luna");
  });

  it("honors overrides and ignores empty values", () => {
    expect(
      readModelsFromEnvironment({
        LLM_MODEL: "custom-primary",
        LLM_FALLBACK_MODEL: "custom-fallback",
      }),
    ).toEqual(["custom-primary", "custom-fallback"]);
    expect(readModelsFromEnvironment({ LLM_MODEL: "", LLM_FALLBACK_MODEL: "" })).toEqual([
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FALLBACK_MODEL,
    ]);
  });
});
