import { z } from "zod";
import { readModelsFromEnvironment } from "./model/modelFallback.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const environmentSchema = z.object({
  OPENAI_API_KEY: z
    .string({ error: "Missing. Set it in the .env file at the repository root." })
    .min(1, "Missing. Set it in the .env file at the repository root."),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  // Reduced to scheme, host and port: the browser sends exactly that as its origin, and an address
  // copied with a trailing slash or a path would otherwise never match and block every request.
  WEB_ORIGIN: z
    .url()
    .transform((address) => new URL(address).origin)
    .default("http://localhost:3000"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

export interface ApiConfig {
  openAiApiKey: string;
  host: string;
  port: number;
  webOrigin: string;
  logLevel: (typeof LOG_LEVELS)[number];
  /** The primary model first, then the fallback. */
  models: string[];
}

export class ConfigurationError extends Error {}

/**
 * Reads and validates the environment once at startup, so a missing key fails immediately with a
 * clear message instead of on the first request. An empty value counts as missing.
 */
export function loadConfig(environment: Record<string, string | undefined>): ApiConfig {
  const present = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = environmentSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `- ${issue.path.join(".") || "environment"}: ${issue.message}`,
    );
    throw new ConfigurationError(`Invalid configuration:\n${problems.join("\n")}`);
  }

  return {
    openAiApiKey: parsed.data.OPENAI_API_KEY,
    host: parsed.data.API_HOST,
    port: parsed.data.PORT,
    webOrigin: parsed.data.WEB_ORIGIN,
    logLevel: parsed.data.LOG_LEVEL,
    models: readModelsFromEnvironment(present),
  };
}
