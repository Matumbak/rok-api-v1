import { NextResponse } from "next/server";
import { withCors } from "@/lib/cors";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_BLOB_BYTES,
  uploadScreenshot,
} from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;

/**
 * POST /api/uploads/screenshot
 * Public endpoint — accepts a single image from the migration application
 * form. Client compresses to WebP before upload; we still validate the
 * content type and size as a server-side belt-and-braces.
 *
 * multipart/form-data fields:
 *   file        — the image (required)
 *   sessionId   — caller-generated random string used to namespace blobs
 *                 under `migration/<sessionId>/...` so cleanup can find
 *                 orphaned uploads if the user abandons the form.
 *   category    — 'account' | 'commander' | 'resource' | 'dkp' (free-form,
 *                 stored as a label on the application later).
 *
 * Returns: { url, pathname, size, contentType }.
 */
export async function POST(request: Request) {
  try {
    const fd = await request.formData();
    const fileField = fd.get("file");
    const sessionId = String(fd.get("sessionId") ?? "");

    if (!fileField || !(fileField instanceof File)) {
      return withCors(
        request,
        NextResponse.json({ error: "no_file" }, { status: 400 }),
      );
    }
    if (!SESSION_ID_RE.test(sessionId)) {
      return withCors(
        request,
        NextResponse.json({ error: "invalid_session_id" }, { status: 400 }),
      );
    }
    if (!ALLOWED_IMAGE_TYPES.has(fileField.type)) {
      return withCors(
        request,
        NextResponse.json(
          { error: "unsupported_content_type", got: fileField.type },
          { status: 400 },
        ),
      );
    }
    if (fileField.size > MAX_BLOB_BYTES) {
      return withCors(
        request,
        NextResponse.json(
          { error: "file_too_large", limit: MAX_BLOB_BYTES },
          { status: 400 },
        ),
      );
    }

    const buffer = Buffer.from(await fileField.arrayBuffer());
    const blob = await uploadScreenshot({
      sessionId,
      filename: fileField.name,
      contentType: fileField.type,
      body: buffer,
    });

    return withCors(request, NextResponse.json(blob, { status: 201 }));
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
