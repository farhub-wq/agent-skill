/**
 * 看守进程：对可能崩溃的长任务做有上限的重启，防止无限重启风暴。
 * 重启强度（窗口内次数）是硬上限，超过即停止。
 */
import type { Tracer } from '../trace/tracer.js';

export interface SupervisorOptions {
  /** 用于记录每次重启与耗尽事件。 */
  tracer: Tracer;
  /** 时间窗口内允许的最大重启次数，默认 3。 */
  maxRestarts?: number;
  /** 统计重启次数的时间窗口，默认 60s。 */
  windowMs?: number;
  /** 指数退避基础延时，默认 100ms。 */
  baseDelayMs?: number;
  /** 可注入的 sleep，测试中避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入时钟，测试中控制时间窗口。 */
  clock?: () => number;
}

/** 重启强度超限时抛出，携带窗口内实际重启次数。 */
export class SupervisorError extends Error {
  constructor(
    message: string,
    readonly restarts: number,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}

export interface Supervisor {
  /** 执行操作，失败时按退避重启；超过强度上限则抛 SupervisorError。 */
  run<T>(label: string, operation: () => Promise<T>): Promise<T>;
}

/** 默认休眠实现，可被测试注入替换。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 创建看守进程。
 * 重启强度是硬上限：窗口内次数用完后直接停，不允许无限重启。
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const maxRestarts = options.maxRestarts ?? 3;
  const windowMs = options.windowMs ?? 60_000;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? (() => Date.now());
  const restarts: number[] = [];

  return {
    async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
      let attempt = 0;
      for (;;) {
        try {
          // 操作成功直接返回，不记录重启。
          return await operation();
        } catch (error) {
          attempt += 1;
          // 只保留当前窗口内的重启时间戳，旧记录自动丢弃。
          const now = clock();
          restarts.push(now);
          const recent = restarts.filter((timestamp) => now - timestamp < windowMs);
          restarts.length = 0;
          restarts.push(...recent);

          // 窗口内重启次数超限：停止重启并上报放弃。
          if (recent.length > maxRestarts) {
            options.tracer.emit('supervisor.restart', {
              label,
              attempt,
              action: 'exhausted',
              restarts: recent.length,
            });
            throw new SupervisorError(
              `restart intensity exceeded for ${label}: ${recent.length} restarts in ${windowMs}ms`,
              recent.length,
            );
          }

          // 指数退避后重启：100ms、200ms、400ms……
          const delayMs = baseDelayMs * 2 ** (attempt - 1);
          options.tracer.emit('supervisor.restart', {
            label,
            attempt,
            delayMs,
            error: (error as Error).message,
          });
          await sleep(delayMs);
        }
      }
    },
  };
}
