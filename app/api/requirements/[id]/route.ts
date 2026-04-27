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
  iconKey: z.string().min(1).max(60),
  order: z.number().int().min(0),
  active: z.boolean(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const data = upsertSchema.partial().parse(body);
    const item = await prisma.migrationRequirement.update({
      where: { id },
      data,
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
    await prisma.migrationRequirement.delete({ where: { id } });
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
