import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exitCodeForSignal,
  getShutdownSignal,
  installSignalHandlers,
  removeSignalHandlers,
  resetShutdown,
  shutdownRequested,
} from './shutdown.js';

describe('shutdown service', () => {
  beforeEach(() => {
    resetShutdown();
  });

  afterEach(() => {
    removeSignalHandlers();
  });

  it('shutdownRequested() returns false initially', () => {
    expect(shutdownRequested()).toBe(false);
  });

  it('getShutdownSignal() returns undefined initially', () => {
    expect(getShutdownSignal()).toBeUndefined();
  });

  it('sets shutdown flag when SIGINT is emitted after install', () => {
    installSignalHandlers();
    process.emit('SIGINT', 'SIGINT');
    expect(shutdownRequested()).toBe(true);
    expect(getShutdownSignal()).toBe('SIGINT');
  });

  it('sets shutdown flag when SIGTERM is emitted after install', () => {
    installSignalHandlers();
    process.emit('SIGTERM', 'SIGTERM');
    expect(shutdownRequested()).toBe(true);
    expect(getShutdownSignal()).toBe('SIGTERM');
  });

  it('does not set flag if handlers are not installed', () => {
    expect(shutdownRequested()).toBe(false);
  });

  it('removeSignalHandlers() stops listening', () => {
    installSignalHandlers();
    removeSignalHandlers();
    expect(shutdownRequested()).toBe(false);
  });

  it('resetShutdown() clears the flag', () => {
    installSignalHandlers();
    process.emit('SIGINT', 'SIGINT');
    expect(shutdownRequested()).toBe(true);
    resetShutdown();
    expect(shutdownRequested()).toBe(false);
    expect(getShutdownSignal()).toBeUndefined();
  });

  it('records the signal that triggered shutdown', () => {
    installSignalHandlers();
    process.emit('SIGINT', 'SIGINT');
    expect(getShutdownSignal()).toBe('SIGINT');
  });
});

describe('exitCodeForSignal', () => {
  it('returns 130 for SIGINT', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130);
  });

  it('returns 143 for SIGTERM', () => {
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
  });

  it('returns 1 for unknown signal', () => {
    expect(exitCodeForSignal(undefined)).toBe(1);
  });
});
