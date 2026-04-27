import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const upsertSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  iconKey: z.string().min(1).max(60).default("Crown"),
  order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

// PUBLIC: list active requirements
export async function GET(request: Request) {
  try {
    const items = await prisma.migrationRequirement.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return withCors(request, NextResponse.json({ items }));
  } catch (err) {
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}

// ADMIN: create
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const data = upsertSchema.parse(body);
    const item = await prisma.migrationRequirement.create({ data });
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
