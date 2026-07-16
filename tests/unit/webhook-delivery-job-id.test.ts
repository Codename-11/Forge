import { describe, expect, it } from "vitest";
import { webhookDeliveryJobId } from "@/server/services/webhook-delivery-job-id";

describe("webhook delivery BullMQ job ids", () => {
  it("keeps attempt dedupe stable without BullMQ's reserved colon delimiter", () => {
    expect(webhookDeliveryJobId("cmr_delivery", 3)).toBe("cmr_delivery-3");
    expect(webhookDeliveryJobId("cmr_delivery", 3)).not.toContain(":");
    expect(webhookDeliveryJobId("cmr_delivery", 4)).not.toBe(
      webhookDeliveryJobId("cmr_delivery", 3),
    );
  });
});
