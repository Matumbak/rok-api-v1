import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_TOKEN = process.env.CRON_TOKEN ?? process.env.ADMIN_TOKEN;

const SEEDS_URL = "https://heroscroll.com/rok/seeds";

interface RawRollup {
  rollup_type: string;
  timestamp: string;
  last_updated: number;
  kingdom_id: number;
  total_power: number;
  total_killpoints: number;
  total_deads: number;
  total_troop_power: number;
  player_count: number;
  ch25_count: number;
  domain_count: number;
  inactive_player_count: number;
  total_acclaim: number;
  rank: number;
  power: number;
  killpoints: number;
  deads: number;
  troop_power: number;
}

/**
 * Weekly refresh of the KingdomSeed table from heroscroll.com/rok/seeds.
 * Mirrors scripts/import-heroscroll-seeds.ts but runs on Vercel Cron.
 *
 *   ranks 1-24                 → "Imperium"
 *   next ⌊(N-24)/4⌋ each       → "A" / "B" / "C" / "D"
 *
 * Auth: Bearer token (CRON_TOKEN). Vercel sends it automatically when
 * scheduled via vercel.json.
 *
 * Idempotent — wipes + re-inserts. Heroscroll updates throughout the
 * week, so weekly cadence keeps our snapshot fresh enough for new
 * applicant seed lookups; on-demand re-runs are also fine via the
 * script when an officer needs a manual refresh.
 */
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !CRON_TOKEN || token !== CRON_TOKEN) {
    return withCors(
      request,
      NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    );
  }

  const t0 = Date.now();
  try {
    const res = await fetch(SEEDS_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (rok-api cron)" },
    });
    if (!res.ok) {
      return withCors(
        request,
        NextResponse.json(
          { error: `heroscroll_${res.status}` },
          { status: 502 },
        ),
      );
    }
    const html = await res.text();

    const re =
      /\\"rollup_type\\":\\"top300\\"[\s\S]*?\\"troop_power\\":\d+/g;
    const matches = html.match(re);
    if (!matches || matches.length === 0) {
      return withCors(
        request,
        NextResponse.json(
          { error: "no_rollups_in_html", hint: "page format may have changed" },
          { status: 502 },
        ),
      );
    }

    const rollups: RawRollup[] = [];
    for (const m of matches) {
      const decoded = m.replace(/\\"/g, '"');
      try {
        rollups.push(JSON.parse("{" + decoded + "}") as RawRollup);
      } catch {
        // skip malformed entries — site occasionally has partial chunks.
      }
    }

    rollups.sort((a, b) => a.rank - b.rank);
    const N = rollups.length;
    const IMPERIUM = 24;
    const remaining = N - IMPERIUM;
    const per = Math.floor(remaining / 4);
    const seedFor = (idx: number): string => {
      if (idx < IMPERIUM) return "Imperium";
      const offset = idx - IMPERIUM;
      if (offset < per) return "A";
      if (offset < 2 * per) return "B";
      if (offset < 3 * per) return "C";
      return "D";
    };

    const data = rollups.map((r, idx) => ({
      kingdomId: r.kingdom_id,
      seed: seedFor(idx),
      rank: r.rank,
      totalPower: r.total_power,
      totalKillpoints: r.total_killpoints,
      totalDeads: r.total_deads,
      totalTroopPower: r.total_troop_power,
      totalAcclaim: r.total_acclaim ?? 0,
      playerCount: r.player_count,
      ch25Count: r.ch25_count,
      domainCount: r.domain_count,
      inactivePlayerCount: r.inactive_player_count,
      scrapedTimestamp: r.timestamp,
      lastUpdated: BigInt(r.last_updated),
    }));

    await prisma.$transaction([
      prisma.kingdomSeed.deleteMany({}),
      prisma.kingdomSeed.createMany({ data }),
    ]);

    return withCors(
      request,
      NextResponse.json({
        ok: true,
        ms: Date.now() - t0,
        rollups: rollups.length,
        scrapedTimestamp: rollups[0]?.timestamp ?? null,
      }),
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

export async function GET(request: Request) {
  return POST(request);
}
