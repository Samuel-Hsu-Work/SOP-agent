import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.ts";
import { createScriptedModelClient } from "./testing/fakeModelClient.ts";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const logLines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const app = await buildServer({
    modelClient: createScriptedModelClient([]),
    models: ["primary-model"],
    webOrigin: "http://localhost:3000",
    logStream,
  });
  openApps.push(app);
  return { app, logLines };
}

function requestLines(logLines: string[]): Record<string, unknown>[] {
  return logLines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "request");
}

describe("request logging", () => {
  it("writes one line per request with the method, path, status, and duration", async () => {
    const { app, logLines } = await createApp();
    await app.inject({ method: "GET", url: "/health" });

    const lines = requestLines(logLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ method: "GET", path: "/health", statusCode: 200 });
    expect(typeof lines[0]?.durationMs).toBe("number");
  });

  it("drops the query string, which could carry user text", async () => {
    const { app, logLines } = await createApp();
    await app.inject({ method: "GET", url: "/health?note=SENTINEL-QUERY-3e9a" });

    expect(logLines.join("")).not.toContain("SENTINEL-QUERY-3e9a");
    expect(requestLines(logLines)[0]).toMatchObject({ path: "/health" });
  });

  it("logs a refused request without its body", async () => {
    const { app, logLines } = await createApp();
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { session: {}, message: "SENTINEL-BODY-77b1" },
      headers: { "content-type": "application/json" },
    });

    expect(logLines.join("")).not.toContain("SENTINEL-BODY-77b1");
    expect(requestLines(logLines)[0]).toMatchObject({
      method: "POST",
      path: "/chat",
      statusCode: 400,
    });
  });
});
