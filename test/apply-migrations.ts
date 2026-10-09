import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Every test file starts from the schema the migrations build, as a fresh
// deployment does. Storage is isolated per test file, so this runs per file.
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
