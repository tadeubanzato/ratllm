import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run real server code against a throwaway PostgreSQL (see scripts/test-integration.sh). They are
// kept out of the default `pnpm test` run so unit tests stay instant and never need Docker.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server Components build; in a plain Node test process it's a no-op.
      "server-only": fileURLToPath(new URL("./tests-integration/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests-integration/**/*.test.ts"],
    setupFiles: ["tests-integration/setup.ts"],
    fileParallelism: false, // every file shares one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
