# HazeHub Cloudflare foundation

**Current deployment:** [Firestore-preserving gateway](FIRESTORE_DEPLOYMENT.md).
The D1/domain architecture below is an inactive prototype, superseded by the
requirement to keep the existing Firestore database authoritative.

Staging Workers stack for the serverless migration. Production remains on Render + Firestore.

| Path | Role |
|------|------|
| `gateway/` | API entry: auth gate, rate limit, correlation IDs, static assets |
| `domain/` | Scouting, sync, auth, analytics jobs, pages, external cache, meetings |
| `domain/realtime.ts` | `MeetingRoom` Durable Object (hibernatable WebSockets) |
| `shared/core.ts` | Env, HMAC sessions, ETag snapshots, Faults |
| `migrations/` | D1 versioned schema |
| `tests/` | Miniflare integration + load estimate |
| `scripts/` | Build + Firestore export validation |

Full design, free-tier model, deploy and rollback: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

```bash
npm install
npm test
npm run bench
npm run dev
```
