// Whether Mojang still certifies players' keys with the keys bundled in
// src/mojang-keys.json: `node scripts/check-mojang-keys.mjs`.
//
// The Worker can't fetch them itself - Mojang's firewall refuses Cloudflare
// (ADR-0020, amended; research 0013 §4) - so they are bundled, and this is
// what notices when they change: run weekly by
// .github/workflows/mojang-keys.yml, whose failure emails the repo's owner.
// Exit 0: the same keys. Exit 1: they changed, and how to update them.
// Exit 2: Mojang couldn't be asked, which says nothing either way.

import { readFileSync } from "node:fs";

const KEYS_URL = "https://api.minecraftservices.com/publickeys";

async function check() {
  const bundled = JSON.parse(readFileSync(new URL("../src/mojang-keys.json", import.meta.url), "utf8"))
    .playerCertificateKeys;

  let live;
  try {
    const response = await fetch(KEYS_URL, {
      headers: { "User-Agent": "ash-backend key check (+https://ashlauncher.com)" },
    });
    if (!response.ok) throw new Error(`${KEYS_URL} answered ${response.status}`);
    live = (await response.json()).playerCertificateKeys.map((key) => key.publicKey);
  } catch (e) {
    console.error(`Couldn't ask Mojang for its keys, so this says nothing either way: ${e.message}`);
    return 2;
  }

  const added = live.filter((key) => !bundled.includes(key));
  const removed = bundled.filter((key) => !live.includes(key));
  if (added.length === 0 && removed.length === 0) {
    console.log(`Mojang's ${live.length} player-certificate keys are the ones bundled.`);
    return 0;
  }
  console.error(`Mojang's player-certificate keys have changed: ${added.length} new, ${removed.length} gone.`);
  console.error("Sign-ins with a key certified by a new one fail with certificate_invalid until");
  console.error(`src/mojang-keys.json is updated from ${KEYS_URL} (playerCertificateKeys[].publicKey) and deployed.`);
  return 1;
}

// Set, not exited with: exiting while fetch's handles close trips a libuv
// assertion on Windows.
process.exitCode = await check();
