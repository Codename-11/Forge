ALTER TABLE "InstanceAuthPolicy"
ADD COLUMN "breakGlassUserId" TEXT;

ALTER TABLE "InstanceAuthPolicy"
ADD CONSTRAINT "InstanceAuthPolicy_breakGlassUserId_fkey"
FOREIGN KEY ("breakGlassUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
