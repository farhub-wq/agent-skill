/**
 * trace 记录器：为一次运行分配 runId，按顺序产出不可变事件。
 * 所有可变状态都封装在闭包里，调用方只能通过接口读取。
 */
import { randomUUID } from 'node:crypto';
import type { TraceEvent, TraceEventType, TraceSink } from './events.js';

export interface Tracer {
  readonly runId: string;
  emit(type: TraceEventType, data?: Record<string, unknown>): TraceEvent;
  events(): readonly TraceEvent[];
}

export interface TracerOptions {
  /** 不传时自动生成 UUID，测试可注入固定值。 */
  runId?: string;
  /** 可选落盘目标，例如 JSONL 账本。 */
  sink?: TraceSink;
  /** 可注入时钟，保证快照与排序测试稳定。 */
  clock?: () => Date;
  idFactory?: () => string;
}

/**
 * 每次运行创建一个 tracer，并显式传递，不提供模块级单例。
 * 原因：并发运行如果共享序号与事件数组，账本会交错，排障时无法还原顺序。
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
      // 先递增序号再冻结事件，确保同一 run 内顺序唯一。
      seq += 1;
      const event: TraceEvent = Object.freeze({
        seq,
        ts: clock().toISOString(),
        runId,
        type,
        // 浅拷贝后冻结，避免调用方事后修改事件载荷。
        data: Object.freeze({ ...data }),
      });
      events.push(event);
      // 落盘失败不阻断主流程，账本是旁路证据而不是执行前提。
      options.sink?.append(event);
      return event;
    },
    events() {
      // 返回副本并冻结，防止外部数组操作污染内部状态。
      return Object.freeze([...events]);
    },
  };
}
