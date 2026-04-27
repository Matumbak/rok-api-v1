import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

const upsertSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  iconKey: z.string().min(1).max(60).default("Crown"),
  order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

// PUBLIC: list active requirements (used by landing)
router.get("/", async (_req, res, next) => {
  try {
    const items = await prisma.migrationRequirement.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// ADMIN: list all (incl. inactive)
router.get("/admin", requireAdmin, async (_req, res, next) => {
  try {
    const items = await prisma.migrationRequirement.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const data = upsertSchema.parse(req.body);
    const item = await prisma.migrationRequirement.create({ data });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const data = upsertSchema.partial().parse(req.body);
    const item = await prisma.migrationRequirement.update({
      where: { id: String(req.params.id) },
      data,
    });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await prisma.migrationRequirement.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
