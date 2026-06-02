// Public surface for the event-bus module.
//
// Consumers should import from this barrel rather than the internal files so
// the schema/bus/sse split stays an implementation detail.

export type { EventBusOptions, EventListener, Unsubscribe } from './bus.js';
export { EventBus, getDefaultEventBus, setDefaultEventBus } from './bus.js';
export type {
  AbortedEvent,
  CostEvent,
  EventWaveName,
  FixDoneEvent,
  FixStartedEvent,
  KovaEvent,
  KovaEventInput,
  SteeredEvent,
  WaveEnterEvent,
  WaveOutputEvent,
} from './schema.js';
export {
  AbortedEventSchema,
  CostEventSchema,
  FixDoneEventSchema,
  FixStartedEventSchema,
  KovaEventSchema,
  SteeredEventSchema,
  WaveEnterEventSchema,
  WaveNameSchema,
  WaveOutputEventSchema,
} from './schema.js';
export type { SseRequestOptions } from './sse.js';
export { handleSseRequest } from './sse.js';
