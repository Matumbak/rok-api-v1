import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const items = await prisma.mediaItem.findMany({
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
