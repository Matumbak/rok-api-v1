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
  {
    url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    title: "Migration Guide — Joining the Horde",
    thumbnail: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg",
    videoId: "M7lc1UVf-VE",
    order: 2,
  },
];

const DKP = [
  ["WarDaddyChadski", "402812837", "HUNS", 184_320_410, 1_842_300_000, 12_840_220, 4_120_510, 3_840_120, 1_984_320],
  ["IronAttila",      "402839172", "HUNS", 162_410_220, 1_624_100_000, 11_220_840, 3_910_020, 3_412_010, 1_762_410],
  ["SteelMongol",     "402841093", "HUNS", 148_905_300, 1_489_050_000, 10_980_410, 3_650_120, 3_120_540, 1_618_905],
  ["BloodMoonKhan",   "402855102", "HUNS", 137_220_910, 1_372_200_000,  9_810_220, 3_220_410, 2_880_330, 1_497_220],
  ["ObsidianWolf",    "402861844", "WLF",  125_780_300, 1_257_800_000,  9_120_410, 2_980_220, 2_640_120, 1_375_780],
  ["NomadicFury",     "402872031", "HUNS", 119_450_220, 1_194_500_000,  8_840_120, 2_810_540, 2_410_220, 1_311_945],
  ["RavenScout",      "402884519", "HUNS", 112_840_120, 1_128_400_000,  8_510_220, 2_640_410, 2_280_410, 1_245_284],
  ["ThunderBjorn",    "402891007", "WLF",  108_420_300, 1_084_200_000,  8_220_410, 2_510_220, 2_140_330, 1_198_842],
  ["FrostHorde",      "402903418", "HUNS", 104_220_910, 1_042_200_000,  7_980_120, 2_410_220, 2_040_120, 1_154_220],
  ["EmberSpear",      "402912205", "WLF",   99_810_220,   998_100_000,  7_640_120, 2_280_410, 1_910_220, 1_098_810],
  ["GrimReaperZ",     "402920718", "HUNS",  96_420_410,   962_400_000,  7_410_220, 2_180_120, 1_840_410, 1_062_420],
  ["VolkanRise",      "402938002", "HUNS",  92_810_120,   928_100_000,  7_180_410, 2_080_220, 1_780_120, 1_028_810],
] as const;

async function main() {
  await prisma.migrationRequirement.deleteMany({});
  await prisma.migrationRequirement.createMany({ data: REQUIREMENTS });

  await prisma.mediaItem.deleteMany({});
  await prisma.mediaItem.createMany({ data: MEDIA });

  await prisma.dkpStanding.deleteMany({});
  await prisma.dkpStanding.createMany({
    data: DKP.map(([nickname, governorId, alliance, power, kp, t4, t5, deaths, dkp], i) => ({
      rank: i + 1,
      governorId,
      nickname,
      alliance,
      power: BigInt(power),
      killPoints: BigInt(kp),
      t4Kills: BigInt(t4),
      t5Kills: BigInt(t5),
      deaths: BigInt(deaths),
      dkp: BigInt(dkp),
    })),
  });

  console.log(
    `[seed] requirements=${REQUIREMENTS.length}, media=${MEDIA.length}, dkp=${DKP.length}`,
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
