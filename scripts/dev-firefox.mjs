#!/usr/bin/env node
import { launchFirefox } from './firefox-runner.mjs';

let session;
const controller = new AbortController();
async function stop(signal) {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  controller.abort(new Error(`Interrupted by ${signal}`));
  if (session) await session.close();
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
try {
  session = await launchFirefox({ startUrl: process.argv[2] ?? 'http://localhost:8000', signal: controller.signal });
  console.log('[firefox] Close this Firefox instance or press Ctrl+C to stop.');
  await session.closed;
} catch (error) {
  console.error(`[firefox] ${error.message}`);
  if (!controller.signal.aborted) process.exitCode = 1;
}
