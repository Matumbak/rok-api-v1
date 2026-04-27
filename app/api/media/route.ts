import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { fetchYoutubeMeta } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(200).optional(),
  order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

// PUBLIC: list active items
export async function GET(request: Request) {
  try {
    const items = await prisma.mediaItem.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });
    return withCors(request, NextResponse.json({ items }));
  } catch (err) {
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}

// ADMIN: create — only `url` required, title/thumb auto-fetched via oEmbed
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const data = createSchema.parse(body);
    const meta = await fetchYoutubeMeta(data.url);
    if (!meta) {
      return withCors(
        request,
        NextResponse.json(
          {
            error: "youtube_url_invalid",
            message: "Could not extract YouTube video id from the URL.",
          },
          { status: 400 },
        ),
      );
    }
    const item = await prisma.mediaItem.create({
      data: {
        url: meta.url,
        title: data.title?.trim() || meta.title,
        thumbnail: meta.thumbnail,
        videoId: meta.videoId,
        order: data.order,
        active: data.active,
      },
    });
    return withCors(request, NextResponse.json(item, { status: 201 }));
  } catch (err) {
    return withCors(request, errorResponse(err));
  }
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      { error: "validation_failed", issues: err.issues },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { error: (err as Error).message ?? "internal_error" },
    { status: 500 },
  );
}
