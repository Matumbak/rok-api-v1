import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { rebuildBenchmark } from "@/lib/benchmarks";
import { type KvkId } from "@/lib/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/benchmarks/upload/[id]
 * Remove a single BenchmarkUpload (e.g. uploaded a wrong-kvkId scan)
 * and rebuild the affected kvkId's benchmark from the remaining uploads.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  try {
    const existing = await prisma.benchmarkUpload.findUnique({
      where: { id },
      select: { kvkId: true },
    });
    if (!existing) {
      return withCors(
        request,
        NextResponse.json({ error: "not_found" }, { status: 404 }),
      );
    }
    await prisma.benchmarkUpload.delete({ where: { id } });
    await rebuildBenchmark(existing.kvkId as KvkId);
    return withCors(request, NextResponse.json({ ok: true }));
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
