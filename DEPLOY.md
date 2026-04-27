# Free deploy walkthrough

End-to-end: GitHub → Neon (Postgres) → Render (API) → Vercel (landing + admin).
Everything below is on free tiers and doesn't require a credit card.

## Prerequisites

- GitHub account with three repos pushed:
  - `rok-api` (this one)
  - `rok-landing`
  - `rok-admin`
- Browser. That's it.

## 1. Database — Neon

1. Sign in at <https://neon.tech> with GitHub.
2. **Create project** → pick a region close to your users (e.g. EU Central / Frankfurt).
3. On the project dashboard, copy the **pooled** connection string under
   *Connection Details*. It looks like:
   ```
   postgresql://USER:PASS@ep-xyz-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```
4. Save it — you'll paste this into Render in step 2.

Free tier: 0.5 GB storage, 5 GB transfer/month, no idle timeout, no expiry.

## 2. API — Render

1. Sign in at <https://render.com> with GitHub.
2. **New + → Blueprint** → connect your `rok-api` repo. Render reads
   [`render.yaml`](./render.yaml) and proposes a single web service.
   Confirm and create.
3. After the service is created, open it → **Environment** and set:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `CORS_ORIGINS` — leave empty for now; you'll fill it once Vercel gives
     you the landing + admin URLs (step 4)
   - `ADMIN_TOKEN` — Render auto-generates one. Open it once and copy it
     somewhere safe; you'll paste it into the admin login.
4. Trigger a manual redeploy after setting env vars. The boot sequence is:
   ```
   npm ci
   npm run build                            # tsc → dist/
   npx prisma db push --skip-generate       # creates tables on Neon
   npx tsx prisma/seed.ts                   # idempotent — defaults for requirements/media
   node dist/index.js                       # listens on $PORT
   ```
5. Hit `https://<your-service>.onrender.com/health` — should return
   `{"status":"ok","uptime":...}`. Note the URL.

Free tier: web service sleeps after 15 min idle; cold start ≈ 30 s.

## 3. Landing — Vercel

1. Sign in at <https://vercel.com> with GitHub.
2. **Add New → Project** → pick your `rok-landing` repo.
3. Vercel auto-detects Next.js. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://<your-rok-api>.onrender.com`
4. **Deploy**. Once it's live, copy the URL (e.g. `https://rok-landing-xxx.vercel.app`).

## 4. Admin — Vercel

1. **Add New → Project** → pick your `rok-admin` repo.
2. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://<your-rok-api>.onrender.com`
   - `NEXT_PUBLIC_LANDING_URL` = `https://<your-rok-landing>.vercel.app`
3. **Deploy**. Copy the URL.

## 5. Wire CORS

Back to Render → `rok-api` → **Environment** → set:

```
CORS_ORIGINS=https://rok-landing-xxx.vercel.app,https://rok-admin-xxx.vercel.app
```

Trigger another redeploy (Render does this automatically on env changes).

## 6. First login + first scan

1. Open `https://<rok-admin>.vercel.app/login`.
2. Paste the `ADMIN_TOKEN` from Render. You'll be redirected to `/requirements`.
3. Sanity check: edit a requirement, save, then visit `https://<rok-landing>.vercel.app/migration` — your edit should appear within 60 seconds (ISR revalidation).
4. Go to `/dkp` in admin → drop your tracker's xlsx file. The leaderboard appears on the public landing immediately.

## Updates

Push to `main` on any of the three repos → Render and Vercel auto-deploy.
Schema changes on `rok-api`: `prisma db push` runs on every boot, so as
long as your changes don't break existing data the next deploy syncs the
DB. For destructive changes, run `prisma migrate dev` locally to generate
a migration and rethink the strategy before pushing.

## Costs (April 2026)

| Service                | Plan       | Limits relevant here                        |
| ---------------------- | ---------- | ------------------------------------------- |
| Neon Postgres          | Free       | 0.5 GB storage, 5 GB egress/mo              |
| Render web service     | Free       | sleeps after 15 min idle, 100 GB egress/mo  |
| Vercel landing + admin | Hobby      | 100 GB egress/mo each, unlimited static     |

Total: $0/mo until traffic exceeds the egress limits, which for a kingdom
landing is essentially never.
