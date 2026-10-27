import { AvailKitClient } from '../../src/index.ts';
import type { BookingInput } from '../../src/index.ts';

/** One booking send followed by one subscription-wide status page. No dispatch or polling. */
export async function bookAndObserve(client: AvailKitClient, subscriptionId: string, input: BookingInput, intentKey: string) {
  const booking = await client.book(input, intentKey);
  const deliveries = await client.listWebhookDeliveries(subscriptionId, { limit: 25 });
  return { booking, deliveries };
}
