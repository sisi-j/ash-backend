# ash-backend

The backend for [ash](https://github.com/sisi-j/ash), a launcher and client for Minecraft: Java Edition. It holds ash accounts, synced settings, news posts, cosmetics and the emote relay.

**NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

The design is in the ash repository:
- [spec 0004](https://github.com/sisi-j/ash/blob/main/docs/specs/0004-phase-4-the-backend.md);
- ADR-0020, the join handshake;
- ADR-0021, this platform;
- ADR-0022, synced settings;
- ADR-0023, keeping no record of who was near whom.

Work is tracked on [sisi-j/ash#117](https://github.com/sisi-j/ash/issues/117).

## What it is

TypeScript on Cloudflare Workers:
- **D1** for accounts, settings and posts;
- **R2** for cosmetic files and each player's equipped-cosmetics file;
- **Durable Objects** for the emote relay.

There are two deployments, `staging` and `production`.

Nothing about playing depends on this service. If it's unreachable, ash loses cosmetics, sync and news, never a launch.

**It never receives a Minecraft or Microsoft token.** A player proves who they are by joining a server id at Mojang's session server, and this service asks Mojang whether they did. The server id is derived on the player's machine from this service's challenge, so this service can't choose it (ADR-0020).

## Running it

```
npm ci
npm run dev        # a local Worker with a local D1, at http://localhost:8787
                   # needs CHALLENGE_SECRET=<anything> in .dev.vars (gitignored)
npm test           # every test, inside workerd, with real local D1
npm run typecheck
npm run types      # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

## Rules the code keeps

- **Real bindings in tests, never mocks.** Tests run inside workerd through `@cloudflare/vitest-plugin`. D1 is a real SQLite database built from `migrations/`.
- **Outside services are parameters.** Mojang's session server is handed to the code that calls it, so tests pass a fake. No test reaches the network, and none needs to mock `fetch`.
- **Errors are JSON with a stable `kind`:** `{"error": {"kind": "not_found", "message": "…"}}`. Clients match on `kind` and never parse `message`, as with ash-core's own errors.
- **The contract with the launcher is held by tests on both sides, not by shared code** (ADR-0021). Each endpoint's response shape is pinned in a test here. ash-core's fake backend is built from the same example files, so a change on one side fails the other's tests.
- **Nothing records who looked up whom.** That covers lookups and the emote relay: no table, no log line, no analytics (ADR-0023).
