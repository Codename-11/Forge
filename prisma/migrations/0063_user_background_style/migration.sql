-- Per-user ambient background style. Additive nullable column; null = "grid" (default).
ALTER TABLE "User" ADD COLUMN "backgroundStyle" TEXT;
