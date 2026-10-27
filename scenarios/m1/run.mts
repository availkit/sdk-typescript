import { AvailKitClient } from '../../src/index.ts';
import { runJourney } from './journey.ts';
import { open } from 'node:fs/promises';

try {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error('Missing configuration');
    return value;
  };
  const client = new AvailKitClient({ baseUrl: required('AVAILKIT_BASE_URL'), workspaceId: required('AVAILKIT_WORKSPACE_ID'), credential: required('AVAILKIT_CREDENTIAL') });
  const bookingFile = required('M1_BOOKING_FILE');
  const result = await runJourney(client, {
    from: required('M1_FROM'), to: required('M1_TO'), intentKey: required('M1_INTENT_KEY'),
    beforeBook: async intent => {
      const file = await open(bookingFile, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(intent) + '\n'); await file.sync(); }
      finally { await file.close(); }
    },
  });
  // Report counts only; service responses and credentials stay out of the terminal.
  process.stdout.write(`M1 complete: ${result.status}; ${result.eventCount} booking events.\n`);
} catch {
  process.stderr.write('M1 journey failed. Inspect private service results; preserve booking input/key for retry.\n');
  process.exitCode = 1;
}
