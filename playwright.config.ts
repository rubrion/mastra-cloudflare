import { defineConfig } from "@playwright/test";

// Standalone test config: boots `wrangler dev` and points the smoke test at
// it. When contributing to the cloudflare/templates monorepo, drop this file —
// that harness provides its own config and a `templateUrl` fixture.
const PORT = 8787;

export default defineConfig({
  testDir: "./playwright-tests",
  use: { baseURL: process.env.TEST_URL || `http://localhost:${PORT}` },
  webServer: process.env.TEST_URL
    ? undefined
    : {
        command: `wrangler dev --port ${PORT} --local`,
        url: `http://localhost:${PORT}/api/agents`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
