import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});

/**
 * BigInt → string (JSON-safe). Used by route handlers when serialising
 * DKP rows (power/killPoints/etc. are BigInt in the DB).
 */
export const bigIntsToStrings = <T>(obj: T): T => {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
};
