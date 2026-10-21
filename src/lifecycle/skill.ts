/**
 * 技能生命周期状态机：discovered -> admitted -> loaded -> active -> disposed。
 * 只允许向前迁移，任意阶段都可直接进入 disposed。
 */
import type { Tracer } from '../trace/tracer.js';

export const LIFECYCLE_STATES = [
  'discovered',
  'admitted',
  'loaded',
  'active',
  'disposed',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

// 合法迁移表；未列出的迁移一律拒绝。
const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  discovered: ['admitted', 'disposed'],
  admitted: ['loaded', 'disposed'],
  loaded: ['active', 'disposed'],
  active: ['disposed'],
  disposed: [],
};

export interface LifecycleHook {
  name: string;
  /** 数值越小越先执行；相同 order 按名称排序。 */
  order: number;
  /** 进入新状态时触发，参数保留迁移前后的状态。 */
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

/**
 * 创建生命周期实例。
 * 一次迁移的执行顺序：校验迁移合法性 -> 更新状态 -> 写 trace -> 依次执行钩子。
 */
export function createLifecycle(
  context: { skill: string; tracer: Tracer },
  hooks: readonly LifecycleHook[] = [],
): Lifecycle {
  // 钩子按 order 升序执行，order 相同用名称保证稳定顺序。
  const ordered = [...hooks].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  let current: LifecycleState = 'discovered';

  return {
    state() {
      return current;
    },
    async transition(to) {
      // 先校验再改状态，非法迁移不会留下半更新状态。
      const allowed = TRANSITIONS[current];
      if (!allowed.includes(to)) {
        throw new LifecycleError(`invalid lifecycle transition ${current} -> ${to}`);
      }
      const from = current;
      current = to;
      // 迁移事件先于钩子写入，钩子失败时仍能看到状态已改变。
      context.tracer.emit('lifecycle.transition', { skill: context.skill, from, to });
      for (const hook of ordered) {
        await hook.onEnter?.(from, to);
      }
      return current;
    },
  };
}
