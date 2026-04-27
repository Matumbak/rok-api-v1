# Free deploy walkthrough

End-to-end: GitHub → Neon (Postgres) → Vercel × 3 (api + landing + admin).
Everything below is on free tiers and **does not require a credit card**.

## Prerequisites

- GitHub account with three repos pushed: `rok-api`, `rok-landing`, `rok-admin`.
- Browser. That's it.

## 1. Database — Neon

1. Sign in at <https://neon.tech> with GitHub. No CC.
2. **Create project** → pick a region close to your users (Frankfurt for EU).
3. On the dashboard, copy the **pooled** connection string under
   *Connection Details*:
   ```
   postgresql://USER:PASS@ep-xyz-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```
4. Save it somewhere — you'll paste it into Vercel in step 2.

Free tier: 0.5 GB storage, 5 GB transfer/month, no idle timeout, no expiry.

## 2. API — Vercel (project #1: `rok-api`)

1. Sign in at <https://vercel.com> with GitHub. No CC for hobby.
2. **Add New → Project** → pick `rok-api` repo.
3. Framework preset: Next.js (auto-detected).
4. **Build Command** — override the default with:
   ```
   prisma generate && prisma db push --skip-generate && next build
   ```
   (`prisma db push` syncs the schema to Neon on every deploy — creates tables on first deploy, no-ops on subsequent ones.)
5. **Environment Variables**:
   - `DATABASE_URL` — the Neon pooled connection string from step 1
   - `ADMIN_TOKEN` — any random string (32+ chars). Generate with `openssl rand -hex 32` or use a password manager. Save it — you'll paste it into the admin login.
   - `CORS_ORIGINS` — leave empty for now; you'll fill it after step 4.
6. **Deploy**. Vercel builds → Prisma syncs schema → app boots.
7. Hit `https://<your-rok-api>.vercel.app/api/health` — should return `{"status":"ok",...}`. Note the URL.

## 3. Landing — Vercel (project #2: `rok-landing`)

1. **Add New → Project** → pick `rok-landing` repo.
2. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://<your-rok-api>.vercel.app`
3. **Deploy**. Once live, copy the URL (e.g. `https://rok-landing-xxx.vercel.app`).

## 4. Admin — Vercel (project #3: `rok-admin`)

1. **Add New → Project** → pick `rok-admin` repo.
2. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://<your-rok-api>.vercel.app`
   - `NEXT_PUBLIC_LANDING_URL` = `https://<your-rok-landing>.vercel.app`
3. **Deploy**. Copy the URL.

## 5. Wire CORS (back to api project)

Vercel project `rok-api` → **Settings → Environment Variables** → set:

```
CORS_ORIGINS=https://rok-landing-xxx.vercel.app,https://rok-admin-xxx.vercel.app
```

Trigger a redeploy of `rok-api` so the new env var takes effect (Settings → Deployments → ⋯ → Redeploy).

## 6. First login + first scan

1. Open `https://<rok-admin>.vercel.app/login`.
2. Paste the `ADMIN_TOKEN` from step 2. You'll be redirected to `/requirements`.
3. Sanity check: edit a requirement, save, then visit `https://<rok-landing>.vercel.app/migration` — your edit should appear within 60 seconds (ISR revalidation).
4. Go to `/dkp` in admin → drop your tracker's `.xlsx` file. The leaderboard appears on the public landing immediately.

## Updates

Push to `main` on any of the three repos → Vercel auto-deploys.

Schema changes on `rok-api`: `prisma db push` runs on every build, so any
non-destructive change syncs automatically. For destructive changes, run
`prisma migrate dev` locally to think through the data migration before
pushing.

## Costs (April 2026)

| Service                 | Plan       | Limits                                   |
| ----------------------- | ---------- | ---------------------------------------- |
| Neon Postgres           | Free       | 0.5 GB storage, 5 GB egress/mo           |
| Vercel rok-api          | Hobby      | 100 GB egress/mo, 10s function timeout (30s on `/upload`) |
| Vercel rok-landing      | Hobby      | 100 GB egress/mo, ISR included           |
| Vercel rok-admin        | Hobby      | 100 GB egress/mo                         |

Total: **$0/mo**, no credit card required at any step.

## Why not Render anymore?

The earlier draft of this guide pointed at Render's free web service tier.
As of 2025-2026 Render gates free tiers behind credit-card validation. By
moving the API onto Next.js Route Handlers we host all three projects on
Vercel hobby — no payment instrument anywhere.
