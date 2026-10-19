# HazeHub Cloudflare Workers Architecture

Staging-only foundation. **Production traffic remains on the Render FastAPI + Firestore stack until cutover is validated.**

## Architecture diagram

```text
                    ┌─────────────────────────────┐
                    │  Next.js static export      │
                    │  IndexedDB / Dexie offline  │
                    └──────────────┬──────────────┘
                                   │ HTTPS / WSS
                    ┌──────────────▼──────────────┐
                    │  Gateway Worker             │
                    │  auth gate · rate limit     │
                    │  correlation · ETag proxy   │
                    │  static ASSETS              │
                    └──────────────┬──────────────┘
                                   │ Service Binding (no public hop)
                    ┌──────────────▼──────────────┐
                    │  Domain Worker              │
                    │  scouting · sync · auth     │
                    │  analytics jobs · pages     │
                    │  external · meetings        │
                    └─┬──────────┬────────────┬───┘
                      │          │            │
               ┌──────▼──┐  ┌────▼─────┐  ┌──▼──────────┐
               │ D1      │  │ Queue    │  │ MeetingRoom │
               │ reports │  │ + cron   │  │ Durable Obj │
               │ metrics │  │ outbox   │  │ hibernatable│
               │ snaps   │  │ deliver  │  │ WebSockets  │
               └─────────┘  └──────────┘  └─────────────┘
```

## Design decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Database | **D1 for staging / target** | Workers-native, transactional scouting writes, free-tier fit. Firestore Admin SDK is not portable to Workers without a bridging service. |
| Firestore during migration | **Read-only export → `source_documents`** | Never dual-write. One source of truth per phase. Original Firestore retained as rollback. |
| Worker count | **2 Workers** (gateway + domain) | Avoids quota myth (“more Workers ≠ more requests”). Domain modules split logically in-process. |
| Analytics | **Incremental `dirty_teams` + snapshots** | Avoids event-wide recompute on every Data Analysis page load. |
| `avg_points` | **Port of expected_points HPR** | Same consensus / Bayesian accuracy / endgame priors; scoring table from `game_definitions`. Match13 stays separate. |
| Realtime | **Durable Object + one-use tickets** | Meeting fanout without bearer tokens in URLs; authoritative picklist body stays in D1. |
| Jobs | **D1 outbox + Queue hint** | Queue Free = 10k ops/day & 24h retention — not the system of record. |
| Auth on Free | **PBKDF2 for staging; scrypt rejected** | Workers Free ~10 ms CPU cannot verify `scrypt(n=16384)`. Cutover requires password reclaim or hybrid login on Render. |

## Free-tier usage model (100 users × 12 h)

| Resource | Limit | Modelled use | Margin |
|----------|-------|--------------|--------|
| Worker requests | 100k/day | ~25–45k with ETag 304 + WS + batched pages | OK |
| Queue ops | 10k/day | ~200–800 coalesced analytics/external jobs | OK if coalesced |
| D1 | Free rows/ops | Dominated by scouting writes + snapshot reads | Monitor |
| DO | Free allocation | 1 DO id per meeting | OK |
| CPU / inv | 10 ms | Bounded dirty-team batches (≤25 teams) | Tight — keep jobs incremental |
| Cron | 1/min | Dispatch outbox only | OK |

If Queue or CPU headroom is exhausted, **do not silently drop scouting durability** — keep Render as primary or move analytics to a paid Workers plan.

## Migration & rollback

1. Keep Render DNS / production unchanged.
2. Deploy `hazehub-*-staging` Workers + D1.
3. Export Firestore → validate with `npm run migrate:validate -- export.json`.
4. Import into `source_documents`, transform into relational tables, verify counts/hashes.
5. Shadow-read staging for one event; compare HPR / reports / meetings.
6. Cut over only after checklist sign-off.
7. **Rollback:** point domain back to Render; D1 staging data is disposable; Firestore untouched.

## Local development

```bash
cd cloudflare
npm install
npm run migrate:local
# create cloudflare/.dev.vars with SESSION_SECRET=...
npm run dev
npm test
npm run bench
```

## Deploy (staging)

```bash
npx wrangler login
npx wrangler d1 create hazehub-staging   # paste id into both wrangler.jsonc files
npx wrangler d1 migrations apply hazehub-staging -c domain/wrangler.jsonc
npx wrangler secret put SESSION_SECRET -c domain/wrangler.jsonc
npx wrangler secret put SESSION_SECRET -c gateway/wrangler.jsonc
npx wrangler deploy -c domain/wrangler.jsonc
npx wrangler deploy -c gateway/wrangler.jsonc
```

Optional secrets: `TBA_AUTH_KEY`, `MATCH13_API_KEY`, `TEAM_PASSWORD`.

## Remaining limitations

- Most FastAPI routes still return **501** on Workers (“use Render”).
- Pit photos / R2, betting, forms/seasons editor, full admin ops not migrated.
- Legacy scrypt login not runnable on Workers Free.
- Analysis port uses staging `game_definitions`; import real season defs before parity claims.
- Load script is Miniflare synthetic — not a venue Wi-Fi rehearsal.
- DLQ configured; operator replay tooling is manual SQL.
