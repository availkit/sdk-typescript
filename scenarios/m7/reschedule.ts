import { AvailKitClient } from '../../src/index.ts';
import type { BookingInput, RescheduleInput, BookingEvent } from '../../src/index.ts';

export interface ReschedulePlan {
  book: BookingInput;
  move: RescheduleInput;
  keys: { book: string; move: string; cancel: string };
}
/** Explicit synthetic book/move/replay/cancel journey; failures stop without compensation.
 * checkpoint must persist each receipt before the next write is sent. */
export async function runReschedule(client: AvailKitClient, plan: ReschedulePlan, checkpoint: (state: unknown) => Promise<void>) {
  const closed = (x: unknown, keys: string[]): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
  const utc = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 19) === x.slice(0, 19);
  if (!closed(plan, ['book', 'move', 'keys']) || !closed(plan.book, ['offeringId', 'start']) || !closed(plan.move, ['expectedStart', 'start']) || !closed(plan.keys, ['book', 'move', 'cancel'])
    || typeof plan.book.offeringId !== 'string' || !plan.book.offeringId.trim() || !utc(plan.book.start) || !utc(plan.move.expectedStart) || !utc(plan.move.start)
    || Date.parse(plan.book.start) !== Date.parse(plan.move.expectedStart) || Date.parse(plan.move.start) === Date.parse(plan.move.expectedStart)
    || !Object.values(plan.keys).every(k => typeof k === 'string' && /^[\x20-\x7e]{16,128}$/.test(k) && k.trim() === k)
    || new Set(Object.values(plan.keys)).size !== 3) throw new Error('Invalid synthetic reschedule plan.');
  // Snapshot before the first await so caller mutation cannot change later intent.
  const saved: ReschedulePlan = JSON.parse(JSON.stringify(plan));
  await checkpoint({ phase: 'before_book', plan: saved });
  const booked = await client.book(saved.book, saved.keys.book);
  await checkpoint({ phase: 'before_move', plan: saved, booked });
  const moved = await client.rescheduleBooking(booked.id, saved.move, saved.keys.move);
  await checkpoint({ phase: 'before_replay', plan: saved, booked, moved });
  const replay = await client.rescheduleBooking(booked.id, saved.move, saved.keys.move);
  if (JSON.stringify(replay) !== JSON.stringify(moved) || moved.offeringId !== booked.offeringId || moved.resourceId !== booked.resourceId) throw new Error('Reschedule identity/replay mismatch.');
  await checkpoint({ phase: 'before_cancel', plan: saved, booked, moved });
  const cancelled = await client.cancel(booked.id, saved.keys.cancel);
  await checkpoint({ phase: 'before_events', plan: saved, booked, moved, cancelled });
  const events: BookingEvent[] = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const result = await client.events({ after, limit: 100 });
    events.push(...result.events.filter(e => e.bookingId === booked.id));
    if (!result.events.length) {
      if (result.nextAfter !== after) throw new Error('Invalid event cursor.');
      break;
    }
    if (result.nextAfter <= after || page === 9) throw new Error('Event observation bound reached.');
    after = result.nextAfter;
  }
  if (events.length !== 3 || ['booking.created', 'booking.rescheduled', 'booking.cancelled'].some(kind => events.filter(e => e.type === kind).length !== 1)) throw new Error('Expected one event per effective transition.');
  const result = { bookingId: booked.id, status: cancelled.status, eventCount: events.length };
  await checkpoint({ phase: 'complete', plan: saved, booked, moved, cancelled, result });
  return result;
}
