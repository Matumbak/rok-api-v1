import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { fetchYoutubeMeta } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().min(1).max(200).optional(),
  thumbnail: z.string().url().optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const data = updateSchema.parse(body);
    const next: Record<string, unknown> = { ...data };

    if (data.url) {
      const meta = await fetchYoutubeMeta(data.url);
      if (!meta) {
        return withCors(
          request,
          NextResponse.json({ error: "youtube_url_invalid" }, { status: 400 }),
        );
      }
      next.url = meta.url;
      next.videoId = meta.videoId;
      next.thumbnail = data.thumbnail ?? meta.thumbnail;
      if (!data.title) next.title = meta.title;
    }

    const item = await prisma.mediaItem.update({
      where: { id },
      data: next,
    });
    return withCors(request, NextResponse.json(item));
  } catch (err) {
    return withCors(request, errorResponse(err));
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    await prisma.mediaItem.delete({ where: { id } });
    return withCors(request, new NextResponse(null, { status: 204 }));
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
