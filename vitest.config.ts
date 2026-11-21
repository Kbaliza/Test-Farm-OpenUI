import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // The integration tests share ONE Postgres DB, so they must not run in
    // parallel across files — that would interleave head-balance mutations.
    fileParallelism: false,
    sequence: { concurrent: false },
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `import "server-only"` throws outside an RSC bundle — stub it for tests.
      "server-only": path.resolve(__dirname, "test/stubs/empty.ts"),
    },
  },
});
