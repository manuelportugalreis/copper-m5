import { defineConfig } from "vitest/config";

// Module 5: `npm run eval` runs only the golden-set evaluation (evals/),
// which calls Gemini and Langfuse. `npm test` never runs it.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
