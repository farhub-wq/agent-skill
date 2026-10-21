/**
 * 过滤链内核：按顺序执行过滤器，最后调用终端处理器。
 * 关键语义：`before` 升序、`after` 逆序回卷；短路必须留事件；
 * 策略错误一律 fail-closed，只读调用上的非策略错误可 fail-open。
 */
import { createHash } from 'node:crypto';
import type { Tracer } from '../trace/tracer.js';

/** 副作用等级决定失败时能否 fail-open：只读可降级，变更与不可逆必须关死。 */
export type SideEffect = 'readonly' | 'mutating' | 'irreversible';

export interface Caller {
  /** 调用方标识，必须非空，审计与限流都依赖它。 */
  id: string;
  /** 角色列表，用于工具级授权检查。 */
  roles: string[];
  /** 可选的租户标识，供多租户场景扩展。 */
  tenant?: string;
}

/** 一次工具调用的完整描述；字段显式传递，避免过滤器读取全局状态。 */
export interface ToolCall {
  id: string;
  tool: string;
  capability: string;
  args: Record<string, unknown>;
  sideEffect: SideEffect;
  caller: Caller;
  skill: string;
  runId: string;
}

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: ToolError;
  meta?: Record<string, unknown>;
}

/**
 * 过滤器契约。
 * `before` 可以调用 `next()` 继续向内，也可以直接返回结果形成短路；
 * `after` 在递归回卷时执行，因此顺序与 `before` 相反。
 */
export interface ToolFilter {
  name: string;
  /** 数值越小越先进入；相同 order 按名称排序。 */
  order: number;
  before?(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>;
  after?(call: ToolCall, result: ToolResult): Promise<ToolResult>;
}

/** 策略拒绝：这类错误永远 fail-closed，不因只读而降级。 */
export class FilterPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FilterPolicyError';
  }
}

export interface FilterChainOptions {
  tracer: Tracer;
}

export interface FilterChain {
  filterNames(): readonly string[];
  run(call: ToolCall, terminal: (call: ToolCall) => Promise<ToolResult>): Promise<ToolResult>;
}

/** 对参数做 sha256 摘要，用于审计与 trace；不落原始参数。 */
export function argsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

/** 构造统一的策略阻止结果，保留触发的过滤器与原因码。 */
function blocked(filter: string, code: string, message: string): ToolResult {
  return {
    ok: false,
    error: { code: 'POLICY_BLOCKED', message: `${filter}: ${code}: ${message}` },
    meta: { failClosed: true, filter, reason: code },
  };
}

/**
 * 创建过滤链。
 * 执行顺序：before 按 order 升序递归进入 -> 终端处理器 -> after 逆序回卷。
 * 过滤器抛错时按副作用分级：策略错误或变更类操作 fail-closed，
 * 只读调用上的普通错误 fail-open 并标记 degraded。
 */
export function createFilterChain(
  filters: readonly ToolFilter[],
  options: FilterChainOptions,
): FilterChain {
  // 先固定顺序，后续运行不再依赖调用方传入的数组顺序。
  const ordered = [...filters].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    filterNames() {
      return ordered.map((filter) => filter.name);
    },
    async run(call, terminal) {
      const tracer = options.tracer;
      // 进入过滤链前先写事件，即使后续全部被拒绝也有调用记录。
      tracer.emit('tool.before', {
        callId: call.id,
        tool: call.tool,
        capability: call.capability,
        sideEffect: call.sideEffect,
        skill: call.skill,
        caller: call.caller.id,
        argsDigest: argsDigest(call.args),
      });

      async function dispatch(index: number): Promise<ToolResult> {
        // 递归出口：所有过滤器都已通过，执行真正的工具处理器。
        if (index >= ordered.length) return terminal(call);
        const filter = ordered[index] as ToolFilter;
        let result: ToolResult;
        let degraded = false;

        if (filter.before === undefined) {
          // 没有 before 钩子就直接向内，after 仍会在回卷时执行。
          result = await dispatch(index + 1);
        } else {
          // calledNext 用于区分“过滤器自己拒绝”与“下游处理器失败”。
          let calledNext = false;
          const next = (): Promise<ToolResult> => {
            calledNext = true;
            return dispatch(index + 1);
          };

          try {
            result = await filter.before(call, next);
          } catch (error) {
            // 下游（含终端处理器）抛出的错误继续向上抛，交给执行器做固定失败映射；
            // 不能在这里当成过滤器故障，否则重试与隔离策略都会失效。
            if (calledNext) throw error;
            // 过滤器自身抛错：区分策略错误与普通实现错误。
            const code = error instanceof FilterPolicyError ? error.code : 'FILTER_ERROR';
            const isPolicy = error instanceof FilterPolicyError;
            tracer.emit('filter.error', {
              filter: filter.name,
              code,
              sideEffect: call.sideEffect,
              action: isPolicy || call.sideEffect !== 'readonly' ? 'fail-closed' : 'fail-open',
            });

            // 策略错误或变更类操作一律关死；只读调用才允许降级继续。
            if (isPolicy || call.sideEffect !== 'readonly') {
              tracer.emit('filter.shortcircuit', { filter: filter.name, code });
              return blocked(filter.name, code, (error as Error).message);
            }

            degraded = true;
            result = await dispatch(index + 1);
          }

          // 过滤器没有调用 next 却正常返回，说明它主动短路。
          if (!calledNext) {
            tracer.emit('filter.shortcircuit', {
              filter: filter.name,
              code: result.error?.code ?? 'SHORT_CIRCUIT',
            });
          }
        }

        // after 在递归回卷阶段执行，天然形成与 before 相反的顺序。
        if (filter.after !== undefined) {
          try {
            result = await filter.after(call, result);
          } catch (error) {
            tracer.emit('filter.error', {
              filter: filter.name,
              code: error instanceof FilterPolicyError ? error.code : 'AFTER_HOOK_ERROR',
              action: 'degraded',
            });
            degraded = true;
          }
        }

        // 只要链路上发生过降级，就在结果里留下标记，便于审计追踪。
        if (degraded) {
          result = { ...result, meta: { ...result.meta, degraded: true } };
        }
        return result;
      }

      const result = await dispatch(0);
      // 最终结果统一写一条 tool.after 或 tool.error，保证调用有始有终。
      if (result.ok) {
        tracer.emit('tool.after', {
          callId: call.id,
          tool: call.tool,
          ok: true,
          degraded: result.meta?.degraded === true,
        });
      } else {
        tracer.emit('tool.error', {
          callId: call.id,
          tool: call.tool,
          code: result.error?.code ?? 'UNKNOWN',
          degraded: result.meta?.degraded === true,
        });
      }
      return result;
    },
  };
}
