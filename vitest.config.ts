import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/**/*.test.ts", "skills/**/*.test.ts"],
    // This one test imports ./index.js, but the extension it covers is parked as
    // index.ts.disabled, so the file cannot load. Its siblings still run.
    exclude: ["**/node_modules/**", "extensions/premium-usage.disabled/index.test.ts"],
    testTimeout: 30000,
  },
});
