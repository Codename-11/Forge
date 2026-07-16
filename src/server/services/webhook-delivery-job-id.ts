/**
 * BullMQ forbids `:` in custom job ids because it reserves the character for
 * its own composite keys. Keep drain dedupe ids stable without borrowing the
 * repeat-job delimiter.
 */
export function webhookDeliveryJobId(deliveryId: string, attempt: number): string {
  return `${deliveryId}-${attempt}`;
}
