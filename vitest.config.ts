import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tests run inside workerd with real local bindings: D1 is a real SQLite
// database built from `migrations/`, never a mock of one.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          CHALLENGE_SECRET: "test-only-secret",
          // test/access-keys.ts stands in for this team.
          ACCESS_TEAM_DOMAIN: "ash-test.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-0123456789abcdef",
          ASSETS_URL: "https://cdn.test",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
