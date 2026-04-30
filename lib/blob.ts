import { put, del, list } from "@vercel/blob";

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export const BLOB_PREFIX = "migration/";

/**
 * Allowed image content types for migration-application uploads.
 * The client is expected to compress to WebP before upload, but we still
 * accept legacy formats in case the user hits a browser that lacks WebP
 * encoding (very old Safari, etc).
 */
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
]);

/** Hard ceiling per file. Client compresses to ~150 KB; we allow 4 MB. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

export interface UploadedBlob {
  url: string;
  pathname: string;
  size: number;
  contentType: string;
}

/**
 * Upload a screenshot to Vercel Blob. The pathname is namespaced by
 * `migration/<sessionId>/<random>.<ext>` so cleanup can scope itself to
 * pending applications.
 */
export async function uploadScreenshot(args: {
  sessionId: string;
  filename: string;
  contentType: string;
  body: Buffer;
}): Promise<UploadedBlob> {
  const ext = (args.contentType.split("/")[1] ?? "webp").replace(
    /[^a-z0-9]/g,
    "",
  );
  const random = Math.random().toString(36).slice(2, 10);
  const pathname = `${BLOB_PREFIX}${args.sessionId}/${Date.now()}-${random}.${ext}`;

  const result = await put(pathname, args.body, {
    access: "public",
    contentType: args.contentType,
    addRandomSuffix: false,
    token: TOKEN,
  });

  return {
    url: result.url,
    pathname: result.pathname,
    size: args.body.length,
    contentType: args.contentType,
  };
}

/** Delete one or more blobs by URL. Silent on missing — idempotent. */
export async function deleteBlobs(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await del(urls, { token: TOKEN });
}

/**
 * List blobs under the migration prefix. Used by the cleanup job to find
 * orphans (uploaded but never linked to an application).
 */
export async function listMigrationBlobs(cursor?: string) {
  return list({
    prefix: BLOB_PREFIX,
    cursor,
    token: TOKEN,
  });
}
