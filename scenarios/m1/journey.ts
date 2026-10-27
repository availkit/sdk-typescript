import { AvailKitClient } from '../../src/index.ts';
import type { BookingInput } from '../../src/index.ts';

/** Uses a fresh synthetic workspace and an explicitly chosen retry key. */
export async function runJourney(client: AvailKitClient, options: { from: string; to: string; intentKey: string; beforeBook?: (intent: Readonly<BookingInput>) => Promise<void> }) {
  if (!/^[\x21-\x7e]{16,121}$/.test(options.intentKey)) throw new Error('Choose an intent key of 16–121 visible ASCII characters.');
  const resource = await client.createResource({ name: 'Consultation desk', timeZone: 'UTC', capacity: 1 });
  await client.replaceHours(resource.id, { windows: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, start: '09:00', end: '17:00' })) });
  const offering = await client.createOffering({ name: 'Consultation', resourceId: resource.id, durationMinutes: 30 });
  const available = await client.availability({ offeringId: offering.id, from: options.from, to: options.to });
  const slot = available.slots[0];
  if (!slot) throw new Error('Choose a future range containing opening hours.');
  const intent = Object.freeze({ offeringId: offering.id, start: slot.start });
  await options.beforeBook?.(intent);
  const booked = await client.book(intent, options.intentKey);
  const replayed = await client.book(intent, options.intentKey);
  if (JSON.stringify(booked) !== JSON.stringify(replayed)) throw new Error('Same-intent replay changed the booking.');
  const cancelled = await client.cancel(booked.id, `${options.intentKey}:cancel`);
  const cancelReplay = await client.cancel(booked.id, `${options.intentKey}:cancel`);
  if (JSON.stringify(cancelled) !== JSON.stringify(cancelReplay)) throw new Error('Same-intent replay changed cancellation.');
  const events: import('../../src/index.ts').BookingEvent[] = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const result = await client.events({ after, limit: 100 });
    events.push(...result.events.filter(event => event.bookingId === booked.id));
    if (result.events.length === 0) {
      if (result.nextAfter !== after) throw new Error('Empty event page changed the cursor.');
      break;
    }
    if (result.nextAfter <= after) throw new Error('Event cursor did not advance.');
    after = result.nextAfter;
    if (page === 9) throw new Error('Event page bound reached; use a fresh synthetic workspace.');
  }
  if (events.filter(e => e.type === 'booking.created').length !== 1 || events.filter(e => e.type === 'booking.cancelled').length !== 1) throw new Error('Expected one committed event per transition.');
  return { resourceId: resource.id, offeringId: offering.id, bookingId: booked.id, status: cancelled.status, eventCount: events.length };
}
