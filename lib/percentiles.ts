/**
 * Percentile-rank computation for migration applications.
 *
 * Uses Postgres `PERCENT_RANK()` window functions over the active
 * cohort (status in pending/approved). Returns 0..1 — 1.0 means top
 * of the table, 0.0 means bottom.
 *
 * Cheap enough to run per-request for the cohort sizes we expect
 * (hundreds, low thousands at peak); no caching layer.
 */

import { prisma } from "@/lib/db";

export interface AppPercentiles {
  power: number | null;
  killPoints: number | null;
  deaths: number | null;
  maxValorPoints: number | null;
  /** Cohort size (active applications considered for the ranking). */
  cohort: number;
}

interface PercentileRow {
  id: string;
  power_pct: number | null;
  kp_pct: number | null;
  deaths_pct: number | null;
  valor_pct: number | null;
}

/**
 * Compute percentiles for a single application by ID. Returns null
 * channels when the corresponding numeric column is null on the
 * applicant — we don't want to invent a rank from missing data.
 *
 * The active cohort is `status IN ('pending', 'approved')` — rejected
 * and archived rows shouldn't drag down a serious applicant's rank.
 */
export async function getPercentilesForApp(
  id: string,
): Promise<AppPercentiles | null> {
  const rows = await prisma.$queryRaw<PercentileRow[]>`
    WITH ranked AS (
      SELECT
        id,
        CASE WHEN "powerN"          IS NULL THEN NULL
             ELSE PERCENT_RANK() OVER (
               PARTITION BY ("powerN" IS NULL)
               ORDER BY "powerN"
             ) END AS power_pct,
        CASE WHEN "killPointsN"     IS NULL THEN NULL
             ELSE PERCENT_RANK() OVER (
               PARTITION BY ("killPointsN" IS NULL)
               ORDER BY "killPointsN"
             ) END AS kp_pct,
        CASE WHEN "deathsN"         IS NULL THEN NULL
             ELSE PERCENT_RANK() OVER (
               PARTITION BY ("deathsN" IS NULL)
               ORDER BY "deathsN"
             ) END AS deaths_pct,
        CASE WHEN "maxValorPointsN" IS NULL THEN NULL
             ELSE PERCENT_RANK() OVER (
               PARTITION BY ("maxValorPointsN" IS NULL)
               ORDER BY "maxValorPointsN"
             ) END AS valor_pct
      FROM migration_applications
      WHERE status IN ('pending', 'approved')
    )
    SELECT * FROM ranked WHERE id = ${id};
  `;
  if (rows.length === 0) return null;
  const r = rows[0];

  const cohortRow = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM migration_applications
    WHERE status IN ('pending', 'approved');
  `;
  const cohort = Number(cohortRow[0]?.count ?? 0n);

  return {
    power: r.power_pct,
    killPoints: r.kp_pct,
    deaths: r.deaths_pct,
    maxValorPoints: r.valor_pct,
    cohort,
  };
}

/**
 * Bulk version for the admin list. Returns a map id → percentiles
 * for every application in the active cohort. Callers that need to
 * decorate a paginated list should hit this once and look up by id.
 */
export async function getCohortPercentiles(): Promise<
  Map<string, AppPercentiles>
> {
  const rows = await prisma.$queryRaw<PercentileRow[]>`
    SELECT
      id,
      CASE WHEN "powerN"          IS NULL THEN NULL
           ELSE PERCENT_RANK() OVER (
             PARTITION BY ("powerN" IS NULL)
             ORDER BY "powerN"
           ) END AS power_pct,
      CASE WHEN "killPointsN"     IS NULL THEN NULL
           ELSE PERCENT_RANK() OVER (
             PARTITION BY ("killPointsN" IS NULL)
             ORDER BY "killPointsN"
           ) END AS kp_pct,
      CASE WHEN "deathsN"         IS NULL THEN NULL
           ELSE PERCENT_RANK() OVER (
             PARTITION BY ("deathsN" IS NULL)
             ORDER BY "deathsN"
           ) END AS deaths_pct,
      CASE WHEN "maxValorPointsN" IS NULL THEN NULL
           ELSE PERCENT_RANK() OVER (
             PARTITION BY ("maxValorPointsN" IS NULL)
             ORDER BY "maxValorPointsN"
           ) END AS valor_pct
    FROM migration_applications
    WHERE status IN ('pending', 'approved');
  `;
  const cohort = rows.length;
  const out = new Map<string, AppPercentiles>();
  for (const r of rows) {
    out.set(r.id, {
      power: r.power_pct,
      killPoints: r.kp_pct,
      deaths: r.deaths_pct,
      maxValorPoints: r.valor_pct,
      cohort,
    });
  }
  return out;
}
