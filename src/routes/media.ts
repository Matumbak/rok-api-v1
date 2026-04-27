import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { fetchYoutubeMeta } from "../services/youtube.js";

const router = Router();

const createSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(200).optional(),
  order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

const updateSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().min(1).max(200).optional(),
  thumbnail: z.string().url().optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

// PUBLIC: list active media items
router.get("/", async (_req, res, next) => {
  try {
    const items = await prisma.mediaItem.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// ADMIN: list all
router.get("/admin", requireAdmin, async (_req, res, next) => {
  try {
    const items = await prisma.mediaItem.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * Create — only `url` is required. Title + thumbnail + canonical URL are
 * pulled from YouTube oEmbed unless the admin manually overrides title.
 */
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const meta = await fetchYoutubeMeta(body.url);
    if (!meta) {
      return res.status(400).json({
        error: "youtube_url_invalid",
        message: "Could not extract YouTube video id from the URL.",
      });
    }

    const item = await prisma.mediaItem.create({
      data: {
        url: meta.url,
        title: body.title?.trim() || meta.title,
        thumbnail: meta.thumbnail,
        videoId: meta.videoId,
        order: body.order,
        active: body.active,
      },
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const next_data: Record<string, unknown> = { ...data };

    // If URL changes, re-resolve oembed
    if (data.url) {
      const meta = await fetchYoutubeMeta(data.url);
      if (!meta) {
        return res.status(400).json({ error: "youtube_url_invalid" });
      }
      next_data.url = meta.url;
      next_data.videoId = meta.videoId;
      next_data.thumbnail = data.thumbnail ?? meta.thumbnail;
      // only auto-fill title if admin didn't pass one
      if (!data.title) next_data.title = meta.title;
    }

    const item = await prisma.mediaItem.update({
      where: { id: String(req.params.id) },
      data: next_data,
    });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /media/refresh-titles — re-fetches title+thumbnail from YouTube
 * for every stored item. Useful as a periodic admin action.
 */
router.post("/refresh-titles", requireAdmin, async (_req, res, next) => {
  try {
    const items = await prisma.mediaItem.findMany();
    let refreshed = 0;
    for (const item of items) {
      const meta = await fetchYoutubeMeta(item.url);
      if (!meta) continue;
      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { title: meta.title, thumbnail: meta.thumbnail },
      });
      refreshed++;
    }
    res.json({ refreshed, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await prisma.mediaItem.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
