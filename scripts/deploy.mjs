// Deploy one environment: `node scripts/deploy.mjs staging|production`.
//
// Run by .github/workflows/deploy.yml with CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in the environment. Idempotent: every step either
// creates what is missing or confirms what is there, so the first deploy and
// the hundredth run the same steps.
//
//   1. the environment's D1 database and R2 bucket exist (created on the first run), and
//      its id goes into this checkout's wrangler.jsonc - never committed;
//   2. migrations are applied to it;
//   3. the Worker is deployed, with the commit as COMMIT;
//   4. CHALLENGE_SECRET is set to a fresh random value - rotating it only
//      invalidates challenges from the last 30 seconds, so nobody keeps it;
//   5. /health on the environment's own host answers with this commit.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const HOSTS = {
  staging: "api-staging.ashlauncher.com",
  production: "api.ashlauncher.com",
};

const env = process.argv[2];
if (!(env in HOSTS)) {
  console.error("usage: node scripts/deploy.mjs staging|production");
  process.exit(2);
}
const commit = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
const database = `ash-${env}`;

function wrangler(args, input) {
  console.log(`> wrangler ${args.join(" ")}`);
  return execFileSync("npx", ["wrangler", ...args], {
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
  }).toString();
}

function databaseId() {
  const all = JSON.parse(wrangler(["d1", "list", "--json"]));
  return all.find((d) => d.name === database)?.uuid;
}

// 1. The database.
let id = databaseId();
if (id === undefined) {
  wrangler(["d1", "create", database]);
  id = databaseId();
}
if (id === undefined) throw new Error(`${database} was not created`);
const config = readFileSync("wrangler.jsonc", "utf8");
const pattern = new RegExp(`("database_name": "${database}",\\s*"database_id": ")[^"]*(")`);
if (!pattern.test(config)) throw new Error(`wrangler.jsonc has no ${database} binding to fill in`);
writeFileSync("wrangler.jsonc", config.replace(pattern, `$1${id}$2`));
console.log(`${database} is ${id}`);

// 1b. The assets bucket: news covers, later cosmetics. Its public custom
// domain (cdn[-staging].ashlauncher.com) is connected once, by hand, in the
// dashboard - see the README.
const bucket = `ash-assets-${env}`;
const buckets = [...wrangler(["r2", "bucket", "list"]).matchAll(/name:\s+(\S+)/g)].map((m) => m[1]);
if (!buckets.includes(bucket)) {
  wrangler(["r2", "bucket", "create", bucket]);
}
console.log(`${bucket} exists`);

// 2. Migrations.
console.log(wrangler(["d1", "migrations", "apply", database, "--env", env, "--remote"]));

// 2b. The catalogue: cosmetics/catalogue.json and its textures. Each texture
// is stored under its content's hash, so a changed image is a new address
// and the old one can be cached for a year without going stale.
const catalogue = JSON.parse(readFileSync("cosmetics/catalogue.json", "utf8")).cosmetics;
const seenIds = new Set();
const rows = [];
for (const c of catalogue) {
  if (!/^[a-z0-9.-]+$/.test(c.id) || seenIds.has(c.id)) throw new Error(`catalogue: bad or repeated id ${c.id}`);
  if (!["cape", "head", "back"].includes(c.slot)) throw new Error(`catalogue: ${c.id} has slot ${c.slot}`);
  if (typeof c.name !== "string" || c.name.includes("'")) throw new Error(`catalogue: ${c.id} needs a plain name`);
  seenIds.add(c.id);
  const bytes = readFileSync(`cosmetics/${c.file}`);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const key = `cosmetics/${hash}-${c.file}`;
  wrangler([
    "r2", "object", "put", `${bucket}/${key}`, "--file", `cosmetics/${c.file}`, "--remote",
    "--content-type", "image/png", "--cache-control", "public, max-age=31536000, immutable",
  ]);
  rows.push(
    `INSERT INTO cosmetics (id, slot, name, texture) VALUES ('${c.id}', '${c.slot}', '${c.name}', '${key}') ` +
      "ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, name = excluded.name, texture = excluded.texture;",
  );
}
if (rows.length > 0) {
  console.log(wrangler(["d1", "execute", database, "--env", env, "--remote", "--command", rows.join(" ")]));
}
console.log(`catalogue: ${rows.length} cosmetic(s)`);

// 3. The Worker.
console.log(wrangler(["deploy", "--env", env, "--var", `COMMIT:${commit}`]));

// 4. The challenge secret.
console.log(wrangler(["secret", "put", "CHALLENGE_SECRET", "--env", env], randomBytes(32).toString("hex")));

// 5. Running. A new custom domain's certificate can take a few minutes.
const url = `https://${HOSTS[env]}/health`;
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  try {
    const response = await fetch(url);
    const body = await response.json();
    if (response.ok && body.commit === commit && body.database === "ok") {
      console.log(`${url} answers ${JSON.stringify(body)}`);
      break;
    }
    console.log(`${url} answered ${response.status} ${JSON.stringify(body)}; waiting`);
  } catch (e) {
    console.log(`${url} not answering yet (${e.cause?.code ?? e.message})`);
  }
  if (Date.now() > deadline) throw new Error(`${url} never answered with ${commit}`);
  await new Promise((r) => setTimeout(r, 15_000));
}
