# rok-api

Express + Prisma + Postgres backend for the 4028 Huns landing.

Endpoints:

| Path                        | Auth   | Purpose                                              |
| --------------------------- | ------ | ---------------------------------------------------- |
| `GET  /health`              | —      | uptime probe (used by Render)                        |
| `GET  /api/requirements`    | public | active migration requirements                        |
| `*    /api/requirements*`   | Bearer | admin CRUD                                           |
| `GET  /api/media`           | public | active media items                                   |
| `*    /api/media*`          | Bearer | admin CRUD + `POST /api/media/refresh-titles`        |
| `GET  /api/dkp`             | public | dynamic table — query: `search`, `alliance`, `sortBy`, `sortOrder`, `page`, `pageSize` |
| `POST /api/dkp/upload`      | Bearer | multipart `file` (.xlsx) — replaces the entire scan  |
| `DELETE /api/dkp`           | Bearer | wipe all DKP rows                                    |

Admin auth: `Authorization: Bearer <ADMIN_TOKEN>`.

## Local development

Requires Node 20+ and a Postgres database (Neon free tier works for both dev
and prod, or run a local container).

```bash
# 1. install
npm install

# 2. point .env at your Postgres
cp .env.example .env
# edit .env and set DATABASE_URL=postgresql://...

# 3. push schema + seed
npm run db:push
npm run db:seed

# 4. run dev server
npm run dev          # http://localhost:4000
```

`prisma db push` syncs the schema directly without generating a migration —
fine for this single-developer project. Switch to `prisma migrate dev` if you
ever need migration history.

## Free deploy: Render + Neon

1. **Create a Postgres database**
   - Sign in at <https://neon.tech> with GitHub
   - Create project → copy the **pooled** connection string (the one ending with `?sslmode=require&channel_binding=require`)

2. **Create the Render service**
   - Sign in at <https://render.com> with GitHub
   - **New +** → **Blueprint** → pick this repo. Render reads `render.yaml`
   - Or **New + → Web Service** manually:
     - Build command: `npm ci && npm run build`
     - Start command: `npx prisma db push --skip-generate && npx tsx prisma/seed.ts && node dist/index.js`
     - Health check path: `/health`
     - Plan: **Free**

3. **Set environment variables in Render dashboard**
   - `DATABASE_URL` — the Neon connection string from step 1
   - `ADMIN_TOKEN` — Render auto-generates a strong token if you used the blueprint; otherwise set your own
   - `CORS_ORIGINS` — comma-separated list, e.g. `https://rok-landing.vercel.app,https://rok-admin.vercel.app`
   - `PORT` — `4000` (Render also injects its own; either works)

4. **First deploy**
   - Render builds → boots → `db push` creates tables on Neon → `seed` inserts default requirements/media → server listens
   - Hit `https://rok-api-xxx.onrender.com/health` — should return `{"status":"ok"}`

5. **Wire frontends** — see `rok-landing` and `rok-admin` READMEs

### Free tier caveat

Render free web services sleep after 15 minutes of no traffic. The first
request after a sleep takes ~30 seconds while the container spins up. For
a public landing this is acceptable; subsequent requests are instant until
the next idle window.

## Tech stack

- Node 22 / TypeScript / ESM
- Express 5 + Multer (file upload) + Zod (validation)
- Prisma 5 + Postgres
- xlsx parser ([SheetJS](https://sheetjs.com)) — auto-detects column types,
  drops nothing, stores extras in JSONB
