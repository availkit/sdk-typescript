import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AvailKitClient } from '../../src/index.ts';
import { bookAndObserve } from './observe.ts';

try {
  const [subscriptionId, inputPath, intentKey] = process.argv.slice(2);
  const { AVAILKIT_BASE_URL: baseUrl, AVAILKIT_WORKSPACE_ID: workspaceId, AVAILKIT_CREDENTIAL: credential } = process.env;
  if (process.argv.length !== 5 || !subscriptionId || !inputPath || !intentKey || !baseUrl || !workspaceId || !credential) throw new Error();
  const file = await open(inputPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) throw new Error();
    const bytes = Buffer.alloc(16385); let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break; used += bytesRead;
    }
    if (used > 16384) throw new Error();
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await file.close(); }
  const result = await bookAndObserve(new AvailKitClient({ baseUrl, workspaceId, credential }), subscriptionId, input, intentKey);
  // IDs/status only. Page is subscription-wide and can include older booking events.
  console.log(JSON.stringify({ bookingStatus: result.booking.status, observedStates: result.deliveries.items.map(d => ({ state: d.state, attempts: d.attempts, lastOutcome: d.lastOutcome })), more: result.deliveries.nextAfter !== null }));
} catch {
  console.error('Booking/status observation failed. Preserve the original booking input, key and authority; inspect booking status before repeating with that same intent. No automatic retry was sent.');
  process.exitCode = 1;
}
