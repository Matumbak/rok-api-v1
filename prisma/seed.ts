import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  // upsert by url for media so re-running seed is idempotent
  for (const r of REQUIREMENTS) {
    const existing = await prisma.migrationRequirement.findFirst({
      where: { title: r.title },
    });
    if (existing) {
      await prisma.migrationRequirement.update({
        where: { id: existing.id },
        data: r,
      });
    } else {
      await prisma.migrationRequirement.create({ data: r });
    }
  }

  for (const m of MEDIA) {
    await prisma.mediaItem.upsert({
      where: { url: m.url },
      create: m,
      update: m,
    });
  }

  console.log(
    `[seed] requirements=${REQUIREMENTS.length}, media=${MEDIA.length}`,
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
