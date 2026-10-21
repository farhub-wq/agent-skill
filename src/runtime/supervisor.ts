import type { Tracer } from '../trace/tracer.js';

export interface SupervisorOptions {
  tracer: Tracer;
  maxRestarts?: number;
  windowMs?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

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
  run<T>(label: string, operation: () => Promise<T>): Promise<T>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Restart intensity is a hard ceiling: once the window is saturated the
 * supervisor stops instead of restarting forever.
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
          return await operation();
        } catch (error) {
          attempt += 1;
          const now = clock();
          restarts.push(now);
          const recent = restarts.filter((timestamp) => now - timestamp < windowMs);
          restarts.length = 0;
          restarts.push(...recent);

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
