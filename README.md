# rok-api

Backend for the 4028 Huns landing. Next.js 16 Route Handlers + Prisma 5 +
Postgres. Deployable to Vercel hobby tier alongside the other two repos —
no credit card required anywhere.

## Endpoints

| Method | Path                            | Auth   | Purpose                                              |
| ------ | ------------------------------- | ------ | ---------------------------------------------------- |
| GET    | `/api/health`                   | —      | uptime probe                                         |
| GET    | `/api/requirements`             | public | active migration requirements                        |
| GET    | `/api/requirements/admin`       | Bearer | all requirements (incl. inactive)                    |
| POST   | `/api/requirements`             | Bearer | create                                               |
| PATCH  | `/api/requirements/:id`         | Bearer | update                                               |
| DELETE | `/api/requirements/:id`         | Bearer | delete                                               |
| GET    | `/api/media`                    | public | active media items                                   |
| GET    | `/api/media/admin`              | Bearer | all media items                                      |
| POST   | `/api/media`                    | Bearer | create — only `url`, title via YouTube oEmbed        |
| PATCH  | `/api/media/:id`                | Bearer | update                                               |
| POST   | `/api/media/refresh-titles`     | Bearer | bulk re-fetch titles from YouTube                    |
| DELETE | `/api/media/:id`                | Bearer | delete                                               |
| GET    | `/api/dkp`                      | public | dynamic table — `search`, `alliance`, `sortBy`, `sortOrder`, `page`, `pageSize` |
| POST   | `/api/dkp/upload`               | Bearer | multipart `file` (.xlsx) — replaces the entire scan  |
| DELETE | `/api/dkp`                      | Bearer | wipe all DKP rows                                    |

Admin auth: `Authorization: Bearer <ADMIN_TOKEN>`.

CORS: regulated by `CORS_ORIGINS` env var (comma-separated list). Empty = allow any origin (dev).

## Local development

You need a Postgres instance. Pick one:

- **Docker (recommended)** — `docker compose up -d` spins up Postgres on
  `localhost:5433`. The included `.env.example` already points at it.
- **Local Postgres via Homebrew** — `brew install postgresql@16` and adjust
  `DATABASE_URL` to `postgresql://localhost:5432/<dbname>`.
- **Neon dev branch** — point `DATABASE_URL` at your Neon connection string
  (uses your free tier; fine for local dev).

```bash
npm install
cp .env.example .env
# edit .env if you're not using docker compose

# bring up the DB (skip if you're using a remote Postgres)
docker compose up -d

npm run db:push        # syncs schema → creates tables
npm run db:seed        # idempotent: creates defaults only if missing
npm run dev            # http://localhost:4000
```

The seed is **create-only** — it never overwrites rows. Re-run it any time;
edits made via the admin UI are preserved.

## Free deploy: Vercel + Neon

See [DEPLOY.md](./DEPLOY.md) for the full end-to-end walkthrough. Short version:

1. Create Neon project → copy pooled connection string
2. Vercel → Add New Project → import this repo
3. Set env: `DATABASE_URL`, `ADMIN_TOKEN` (any random string), `CORS_ORIGINS`
4. **Build command override**: `prisma generate && prisma db push --skip-generate && next build`
5. Deploy

Vercel hobby tier:
- 100 GB bandwidth/month
- Serverless functions: 10s timeout (we use 30s on `/upload` via `maxDuration`)
- No sleep / cold-start gates beyond standard serverless cold start

## Stack

- Next.js 16 App Router (Route Handlers, no UI)
- TypeScript / Zod validation
- Prisma 5 + Postgres (JSONB for flexible DKP schema)
- xlsx ([SheetJS](https://sheetjs.com)) — auto-detects column types,
  stores everything in JSONB
