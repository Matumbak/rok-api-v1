import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { classifyKingdomTiers } from "@/lib/kingdom-tier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/benchmarks/reclassify-kingdoms — admin-only.
 *
 * Recomputes `KingdomSeed.tier` from the current `totalKillpoints`
 * snapshot. Run on demand:
 *   - after a manual heroscroll-seeds re-import
 *   - after tweaking the cutoffs in lib/kingdom-tier.ts
 *   - any time officers want kingdom tiers re-derived without
 *     waiting for the weekly cron
 *
 * Idempotent. Returns the per-seed tier breakdown so the admin UI
 * can confirm the partition (e.g. "A: 77 high / 153 mid / 536 low").
 *
 * The same logic also runs at the tail of the refresh-kingdom-seeds
 * cron — this endpoint is just the manual trigger.
 */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const result = await classifyKingdomTiers();
    return withCors(
      request,
      NextResponse.json({ ok: true, ...result }),
    );
  } catch (err) {
    return withCors(
      request,
      NextResponse.json(
        { error: (err as Error).message ?? "internal_error" },
        { status: 500 },
      ),
    );
  }
}
