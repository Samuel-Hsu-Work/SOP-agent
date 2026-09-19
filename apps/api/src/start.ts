import OpenAI from "openai";
import { ConfigurationError, loadConfig } from "./env.ts";
import { createOpenAiModelClient } from "./model/openaiModelClient.ts";
import { buildServer } from "./server.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const server = await buildServer({
  modelClient: createOpenAiModelClient(new OpenAI({ apiKey: config.openAiApiKey })),
  models: config.models,
  webOrigin: config.webOrigin,
  logLevel: config.logLevel,
});

await server.listen({ host: config.host, port: config.port });
