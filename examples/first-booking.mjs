// Run once from a new consumer project after following https://availkit.dev/sdk.
// Keep private/ outside source control. A saved intent blocks accidental reruns.
import { createNodeClient } from '@availkit/booking/node';
import { AvailKitError } from '@availkit/booking';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const workspaceId = process.env.AVAILKIT_WORKSPACE_ID;
const baseUrl = process.env.AVAILKIT_BASE_URL;
const client = await createNodeClient({
  baseUrl, workspaceId,
  credentialFile: process.env.AVAILKIT_CREDENTIAL_FILE,
  credential: process.env.AVAILKIT_CREDENTIAL
});
const from = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const to = new Date(Date.parse(from) + 7 * 86400000).toISOString();
const availability = await client.availability({
  offeringId: process.env.AVAILKIT_OFFERING_ID, from, to
});
if (!availability.slots.length) throw Error('No times: check offering and weekly hours.');
const intent = {
  baseUrl, workspaceId, environment: 'test',
  credentialFingerprint: client.credentialFingerprint,
  createdAt: new Date().toISOString(), key: randomUUID(),
  body: { offeringId: process.env.AVAILKIT_OFFERING_ID,
    start: availability.slots[0].start }
};
const file = openSync('./private/first-booking-intent.json', 'wx', 0o600);
try { writeFileSync(file, JSON.stringify(intent)); fsyncSync(file); }
finally { closeSync(file); }
let booking;
try {
  booking = await client.book(intent.body, intent.key);
} catch (error) {
  console.error(JSON.stringify({
    outcome: error instanceof AvailKitError ? error.outcome : 'unknown',
    action: 'Stop. Keep the intent and original key; inspect current bookings. Do not rerun.'
  }));
  process.exit(1);
}
// The server confirmed this booking even if saving the local result later fails.
console.log('Confirmed booking:', booking.id);
const result = openSync('./private/first-booking-result.json', 'wx', 0o600);
try { writeFileSync(result, JSON.stringify(booking)); fsyncSync(result); }
finally { closeSync(result); }
const current = await client.getBooking(booking.id);
console.log('Current status:', current.status);
