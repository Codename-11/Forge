-- Align DB default with Prisma schema: only the compatibility DM isDefault=true.
-- Existing rows were marked true in 0030; future named conversations should default false.
ALTER TABLE "ChatThread" ALTER COLUMN "isDefault" SET DEFAULT false;
