export const TRACE_EVENT_TYPES = [
  'run.start',
  'run.end',
  'admission.start',
  'admission.gate',
  'admission.verdict',
  'lifecycle.transition',
  'skill.post-process',
  'tool.before',
  'tool.after',
  'tool.error',
  'filter.error',
  'filter.shortcircuit',
  'audit.record',
  'execution.retry',
  'execution.result',
  'sandbox.start',
  'sandbox.end',
  'sandbox.egress-blocked',
  'supervisor.restart',
  'eval.case',
  'eval.summary',
  'evidence.written',
  'adapter.pre-tool-use',
  'adapter.post-tool-use',
] as const;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export interface TraceEvent {
  seq: number;
  ts: string;
  runId: string;
  type: TraceEventType;
  data: Readonly<Record<string, unknown>>;
}

export interface TraceSink {
  append(event: TraceEvent): void;
}

export function isTraceEventType(value: string): value is TraceEventType {
  return (TRACE_EVENT_TYPES as readonly string[]).includes(value);
}
