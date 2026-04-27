import { PrismaClient } from "@prisma/client";

// Reuse PrismaClient across hot reloads in dev and across serverless
// invocations in prod (Vercel) to avoid exhausting connection pool.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
