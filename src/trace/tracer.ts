import { randomUUID } from 'node:crypto';
import type { TraceEvent, TraceEventType, TraceSink } from './events.js';

export interface Tracer {
  readonly runId: string;
  emit(type: TraceEventType, data?: Record<string, unknown>): TraceEvent;
  events(): readonly TraceEvent[];
}

export interface TracerOptions {
  runId?: string;
  sink?: TraceSink;
  clock?: () => Date;
  idFactory?: () => string;
}

/**
 * Tracers are created per run and passed explicitly. There is deliberately no
 * module-level singleton: two concurrent runs must never share sequence state.
 */
export function createTracer(options: TracerOptions = {}): Tracer {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const runId = options.runId ?? idFactory();
  const events: TraceEvent[] = [];
  let seq = 0;

  return {
    runId,
    emit(type, data = {}) {
      seq += 1;
      const event: TraceEvent = Object.freeze({
        seq,
        ts: clock().toISOString(),
        runId,
        type,
        data: Object.freeze({ ...data }),
      });
      events.push(event);
      options.sink?.append(event);
      return event;
    },
    events() {
      return Object.freeze([...events]);
    },
  };
}
