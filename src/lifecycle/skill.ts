import type { Tracer } from '../trace/tracer.js';

export const LIFECYCLE_STATES = [
  'discovered',
  'admitted',
  'loaded',
  'active',
  'disposed',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  discovered: ['admitted', 'disposed'],
  admitted: ['loaded', 'disposed'],
  loaded: ['active', 'disposed'],
  active: ['disposed'],
  disposed: [],
};

export interface LifecycleHook {
  name: string;
  order: number;
  onEnter?(from: LifecycleState, to: LifecycleState): void | Promise<void>;
}

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export interface Lifecycle {
  state(): LifecycleState;
  transition(to: LifecycleState): Promise<LifecycleState>;
}

export function createLifecycle(
  context: { skill: string; tracer: Tracer },
  hooks: readonly LifecycleHook[] = [],
): Lifecycle {
  const ordered = [...hooks].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  let current: LifecycleState = 'discovered';

  return {
    state() {
      return current;
    },
    async transition(to) {
      const allowed = TRANSITIONS[current];
      if (!allowed.includes(to)) {
        throw new LifecycleError(`invalid lifecycle transition ${current} -> ${to}`);
      }
      const from = current;
      current = to;
      context.tracer.emit('lifecycle.transition', { skill: context.skill, from, to });
      for (const hook of ordered) {
        await hook.onEnter?.(from, to);
      }
      return current;
    },
  };
}
