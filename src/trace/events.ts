/**
 * trace 事件类型全集。
 * 事件按生命周期分组：运行、准入、生命周期、工具调用、过滤、审计、执行、
 * 沙箱、监督器、评测、证据与适配器。
 * 测试会断言实际产生的事件集合与本列表完全相等，防止新增事件漏写 trace。
 */
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

/** 单条 trace 事件；`seq` 在同一 run 内单调递增，便于恢复顺序。 */
export interface TraceEvent {
  seq: number;
  ts: string;
  runId: string;
  type: TraceEventType;
  data: Readonly<Record<string, unknown>>;
}

/** 事件落盘接口：JSONL 账本、内存收集器或测试替身都实现它。 */
export interface TraceSink {
  append(event: TraceEvent): void;
}

/** 读取外部账本时用于校验事件类型，避免未知事件混入统计。 */
export function isTraceEventType(value: string): value is TraceEventType {
  return (TRACE_EVENT_TYPES as readonly string[]).includes(value);
}
