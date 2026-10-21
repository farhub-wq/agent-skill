import { createHash } from 'node:crypto';
import type { Tracer } from '../trace/tracer.js';

export type SideEffect = 'readonly' | 'mutating' | 'irreversible';

export interface Caller {
  id: string;
  roles: string[];
  tenant?: string;
}

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

export interface ToolFilter {
  name: string;
  order: number;
  before?(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>;
  after?(call: ToolCall, result: ToolResult): Promise<ToolResult>;
}

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

export function argsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

function blocked(filter: string, code: string, message: string): ToolResult {
  return {
    ok: false,
    error: { code: 'POLICY_BLOCKED', message: `${filter}: ${code}: ${message}` },
    meta: { failClosed: true, filter, reason: code },
  };
}

/**
 * `before` runs in ascending order, `after` unwinds in reverse. A filter that
 * returns without invoking `next` is a short circuit and always leaves an event.
 * Non-policy failures fail open for read-only calls only; policy decisions and
 * anything with side effects fail closed.
 */
export function createFilterChain(
  filters: readonly ToolFilter[],
  options: FilterChainOptions,
): FilterChain {
  const ordered = [...filters].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    filterNames() {
      return ordered.map((filter) => filter.name);
    },
    async run(call, terminal) {
      const tracer = options.tracer;
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
        if (index >= ordered.length) return terminal(call);
        const filter = ordered[index] as ToolFilter;
        let result: ToolResult;
        let degraded = false;

        if (filter.before === undefined) {
          result = await dispatch(index + 1);
        } else {
          let calledNext = false;
          const next = (): Promise<ToolResult> => {
            calledNext = true;
            return dispatch(index + 1);
          };

          try {
            result = await filter.before(call, next);
          } catch (error) {
            // A rejection that came from downstream (including the terminal
            // handler) is not a filter failure: the executor must see it to
            // apply the fixed failure mapping.
            if (calledNext) throw error;
            const code = error instanceof FilterPolicyError ? error.code : 'FILTER_ERROR';
            const isPolicy = error instanceof FilterPolicyError;
            tracer.emit('filter.error', {
              filter: filter.name,
              code,
              sideEffect: call.sideEffect,
              action: isPolicy || call.sideEffect !== 'readonly' ? 'fail-closed' : 'fail-open',
            });

            if (isPolicy || call.sideEffect !== 'readonly') {
              tracer.emit('filter.shortcircuit', { filter: filter.name, code });
              return blocked(filter.name, code, (error as Error).message);
            }

            degraded = true;
            result = await dispatch(index + 1);
          }

          if (!calledNext) {
            tracer.emit('filter.shortcircuit', {
              filter: filter.name,
              code: result.error?.code ?? 'SHORT_CIRCUIT',
            });
          }
        }

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

        if (degraded) {
          result = { ...result, meta: { ...result.meta, degraded: true } };
        }
        return result;
      }

      const result = await dispatch(0);
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
