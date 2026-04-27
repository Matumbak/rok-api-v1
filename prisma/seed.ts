import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Seeding strategy: **create-only**. We never overwrite existing records,
 * so re-running this against a database that an admin has already edited
 * is a no-op.
 *
 * Run manually after a fresh DB:
 *   npm run db:seed
 */

const KINGDOM_STATS = [
  { label: "KvK Wins", value: "7", iconKey: "Trophy", order: 0 },
  { label: "Total Power", value: "84.2B", iconKey: "Zap", order: 1 },
  { label: "Active Governors", value: "1,240", iconKey: "Users", order: 2 },
  { label: "Kill Points", value: "12.6T", iconKey: "Skull", order: 3 },
];

const REQUIREMENTS = [
  {
    title: "Power 60M+",
    description: "Solid base for the next KvK season.",
    iconKey: "Crown",
    order: 0,
  },
  {
    title: "T5 Ready",
    description: "Maxed commanders & T5 troop production unlocked.",
    iconKey: "Swords",
    order: 1,
  },
  {
    title: "Kill Points Focus",
    description: "Active in Ark, Pass and KvK rallies.",
    iconKey: "Target",
    order: 2,
  },
  {
    title: "Discord Active",
    description: "Voice-ready during prime war windows.",
    iconKey: "Flame",
    order: 3,
  },
];

const MEDIA = [
  {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "KvK 7 Finale — Last Stand at the Pass",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    videoId: "dQw4w9WgXcQ",
    order: 0,
  },
  {
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
    title: "Ark of Osiris — 4028 Coordinated Push",
    thumbnail: "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg",
    videoId: "9bZkp7q19f0",
    order: 1,
  },
];

async function main() {
  let stats = 0;
  for (const s of KINGDOM_STATS) {
    const existing = await prisma.kingdomStat.findFirst({
      where: { label: s.label },
    });
    if (!existing) {
      await prisma.kingdomStat.create({ data: s });
      stats++;
    }
  }

  let requirements = 0;
  for (const r of REQUIREMENTS) {
    const existing = await prisma.migrationRequirement.findFirst({
      where: { title: r.title },
    });
    if (!existing) {
      await prisma.migrationRequirement.create({ data: r });
      requirements++;
    }
  }

  let media = 0;
  for (const m of MEDIA) {
    const existing = await prisma.mediaItem.findUnique({
      where: { url: m.url },
    });
    if (!existing) {
      await prisma.mediaItem.create({ data: m });
      media++;
    }
  }

  console.log(
    `[seed] created (existing rows preserved): kingdomStats=${stats}, requirements=${requirements}, media=${media}`,
  );
  console.log(
    "[seed] DKP standings are seeded by uploading an xlsx via the admin UI.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
