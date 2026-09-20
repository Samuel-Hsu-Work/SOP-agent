import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The eval calls the live model, so it needs OPENAI_API_KEY. Load it from the repository root .env
// the same way the API and the smoke test do. A missing file is fine: the key may already be set.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file.
}

export default defineConfig({
  test: {
    include: ["src/evals/**/*.eval.ts"],
    // A scenario runs several trials of several model calls each.
    testTimeout: 15 * 60 * 1000,
    fileParallelism: false,
  },
});
