import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { DFT_CURSOR_USAGE: "off", DFT_PRICE_CATALOG: "off" },
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
