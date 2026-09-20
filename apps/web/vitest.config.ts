import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app's tsconfig keeps JSX for Next to compile, so tests turn it into calls themselves.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    // Pure view-model tests stay in the fast node environment. A component test opts into a DOM
    // with a `// @vitest-environment happy-dom` comment at the top of its file.
    environment: "node",
    exclude: ["node_modules/**", ".next/**"],
  },
});
