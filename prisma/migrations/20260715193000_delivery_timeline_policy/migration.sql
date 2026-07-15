CREATE TYPE "DeliveryTimelinePolicy" AS ENUM ('OFF', 'RECOMMEND', 'REQUIRE_ON_PR', 'AUTO_ON_PR');

ALTER TABLE "Workspace"
ADD COLUMN "deliveryTimelinePolicy" "DeliveryTimelinePolicy" NOT NULL DEFAULT 'RECOMMEND';
