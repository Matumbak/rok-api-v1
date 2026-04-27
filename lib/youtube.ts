/**
 * YouTube helper — extract videoId from any common URL form,
 * fetch title + thumbnail via the public oEmbed endpoint (no API key).
 */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

export type YoutubeMeta = {
  videoId: string;
  title: string;
  thumbnail: string;
  url: string;
};

export function extractVideoId(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(u.hostname)) return null;

  // youtu.be/<id>
  if (u.hostname === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return id || null;
  }

  // youtube.com/watch?v=<id>
  const v = u.searchParams.get("v");
  if (v) return v;

  // youtube.com/shorts/<id> | /embed/<id> | /live/<id>
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  if (m) return m[1];

  return null;
}

/**
 * Calls https://www.youtube.com/oembed?url=... — public, no API key.
 * Returns null if the request fails or the URL isn't a valid YouTube video.
 */
export async function fetchYoutubeMeta(
  rawUrl: string,
): Promise<YoutubeMeta | null> {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) return null;

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;

  try {
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": "rok-api/1.0 (+huns4028)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    if (!data.title) return null;

    return {
      videoId,
      title: data.title,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: canonicalUrl,
    };
  } catch (err) {
    console.warn("[youtube] oEmbed fetch failed:", err);
    return null;
  }
}
