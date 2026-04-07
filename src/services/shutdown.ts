// Cooperative graceful shutdown for SIGINT/SIGTERM.
// Sets a flag that pipeline loops check between waves/issues.
// Does NOT abort mid-wave — the current SDK query() finishes first.

import { log } from '../utils/logger.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

let _shutdownRequested = false;
let _signal: ShutdownSignal | undefined;

const handlers = new Map<string, NodeJS.SignalsListener>();

export function shutdownRequested(): boolean {
  return _shutdownRequested;
}

export function getShutdownSignal(): ShutdownSignal | undefined {
  return _signal;
}

export function installSignalHandlers(): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const handler: NodeJS.SignalsListener = () => {
      if (_shutdownRequested) {
        log.warn(`Received ${sig} again — forcing exit`);
        process.exit(exitCodeForSignal(sig));
      }
      _shutdownRequested = true;
      _signal = sig;
      log.info(`Received ${sig} — finishing current wave, then shutting down`);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
}

export function removeSignalHandlers(): void {
  for (const [sig, handler] of handlers) {
    process.removeListener(sig, handler);
  }
  handlers.clear();
}

export function resetShutdown(): void {
  _shutdownRequested = false;
  _signal = undefined;
}

export function exitCodeForSignal(signal: ShutdownSignal | undefined): number {
  switch (signal) {
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    default:
      return 1;
  }
}
