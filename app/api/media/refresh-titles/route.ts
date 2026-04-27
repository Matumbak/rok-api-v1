import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { fetchYoutubeMeta } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ADMIN: bulk re-fetch title+thumbnail from YouTube oEmbed for every stored item.
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const items = await prisma.mediaItem.findMany();
    let refreshed = 0;
    for (const item of items) {
      const meta = await fetchYoutubeMeta(item.url);
      if (!meta) continue;
      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { title: meta.title, thumbnail: meta.thumbnail },
      });
      refreshed++;
    }
    return withCors(
      request,
      NextResponse.json({ refreshed, total: items.length }),
    );
  } catch (err) {
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}
