-- AXI-58: place goals in the strategy hierarchy under an Initiative.
ALTER TABLE "Goal" ADD COLUMN "initiativeId" TEXT;

ALTER TABLE "Goal" ADD CONSTRAINT "Goal_initiativeId_fkey"
  FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Goal_initiativeId_idx" ON "Goal"("initiativeId");
