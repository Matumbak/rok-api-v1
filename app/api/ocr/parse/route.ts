import { NextResponse } from "next/server";
import { z } from "zod";
import { withCors } from "@/lib/cors";
import { extractRokScreen } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  blobUrl: z.string().url(),
});

const ALLOWED_MIME = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
  "image/jpg",
]);

/** Cap the source blob size — Gemini Flash accepts up to 20MB but we
 *  compress to ~150KB on the client, so anything beyond a few MB is
 *  almost certainly an attack / accidental upload of a non-RoK image. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/ocr/parse
 *
 * Body: { blobUrl }
 *
 * Public endpoint — anyone can call it during the migration form flow.
 * The blob URL must be one we just issued from /api/uploads/screenshot
 * (Vercel Blob URLs are unguessable random strings, so this is fine).
 *
 * Returns the universal RoK ParsedRokScreen object — every field is
 * either a raw-integer string ("84200000") or null. The client maps it
 * onto the form state.
 */
export async function POST(request: Request) {
  try {
    const json = await request.json();
    const { blobUrl } = bodySchema.parse(json);

    // Only allow our Vercel Blob domain to be fetched — closes off
    // SSRF abuse where a caller hands us an internal IP / metadata URL.
    const hostOk =
      /\.public\.blob\.vercel-storage\.com$/i.test(new URL(blobUrl).hostname) ||
      /\.blob\.vercel-storage\.com$/i.test(new URL(blobUrl).hostname);
    if (!hostOk) {
      return withCors(
        request,
        NextResponse.json({ error: "blob_url_not_allowed" }, { status: 400 }),
      );
    }

    const fetched = await fetch(blobUrl);
    if (!fetched.ok) {
      return withCors(
        request,
        NextResponse.json(
          { error: "blob_fetch_failed", status: fetched.status },
          { status: 400 },
        ),
      );
    }

    const contentType = (fetched.headers.get("content-type") ?? "").split(
      ";",
    )[0];
    if (!ALLOWED_MIME.has(contentType)) {
      return withCors(
        request,
        NextResponse.json(
          { error: "unsupported_content_type", got: contentType },
          { status: 400 },
        ),
      );
    }

    const buf = Buffer.from(await fetched.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return withCors(
        request,
        NextResponse.json(
          { error: "blob_too_large", size: buf.length, limit: MAX_BYTES },
          { status: 400 },
        ),
      );
    }

    const parsed = await extractRokScreen({
      imageData: buf,
      mimeType: contentType,
    });

    return withCors(request, NextResponse.json({ ok: true, data: parsed }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return withCors(
        request,
        NextResponse.json(
          { error: "validation_failed", issues: err.issues },
          { status: 400 },
        ),
      );
    }
    return withCors(
      request,
      NextResponse.json(
        { error: (err as Error).message ?? "internal_error" },
        { status: 500 },
      ),
    );
  }
}
