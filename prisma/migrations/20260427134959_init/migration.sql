-- CreateTable
CREATE TABLE "migration_requirements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "iconKey" TEXT NOT NULL DEFAULT 'Crown',
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "media_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "dkp_standings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rank" INTEGER NOT NULL,
    "governorId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "alliance" TEXT NOT NULL,
    "power" BIGINT NOT NULL,
    "killPoints" BIGINT NOT NULL,
    "t4Kills" BIGINT NOT NULL,
    "t5Kills" BIGINT NOT NULL,
    "deaths" BIGINT NOT NULL,
    "dkp" BIGINT NOT NULL,
    "scanDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "media_items_url_key" ON "media_items"("url");

-- CreateIndex
CREATE INDEX "dkp_standings_rank_idx" ON "dkp_standings"("rank");

-- CreateIndex
CREATE INDEX "dkp_standings_nickname_idx" ON "dkp_standings"("nickname");

-- CreateIndex
CREATE INDEX "dkp_standings_alliance_idx" ON "dkp_standings"("alliance");

-- CreateIndex
CREATE INDEX "dkp_standings_dkp_idx" ON "dkp_standings"("dkp");
