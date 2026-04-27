import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Vercel from precompiling Prisma's binary engines
  serverExternalPackages: ["@prisma/client", "xlsx"],
};

export default nextConfig;
