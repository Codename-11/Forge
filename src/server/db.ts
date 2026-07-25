import "server-only";
import { PrismaClient } from "@prisma/client";
import { prismaLogLevels } from "./db-log";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLogLevels(process.env),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
