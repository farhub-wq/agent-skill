import path from 'node:path';
import { toolFamily } from '../admission/skill-md.js';
import {
  createFilterChain,
  type ToolCall,
  type ToolFilter,
  type ToolResult,
} from '../filters/chain.js';
import type { RunContext } from './context.js';

export type FailureClass = 'transient' | 'semantic' | 'policy' | 'environment' | 'unknown';

export interface FailurePolicy {
  retries: number;
  escalate: boolean;
  quarantine: boolean;
}

/** Fixed mapping: skill authors cannot choose their own retry semantics. */
export const FAILURE_MAPPING: Readonly<Record<FailureClass, FailurePolicy>> = Object.freeze({
  transient: { retries: 3, escalate: false, quarantine: false },
  semantic: { retries: 0, escalate: true, quarantine: false },
  policy: { retries: 0, escalate: true, quarantine: true },
  environment: { retries: 0, escalate: false, quarantine: false },
  unknown: { retries: 1, escalate: true, quarantine: false },
});

export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export type ToolHandler = (
  call: ToolCall,
  context: RunContext,
) => Promise<unknown> | unknown;

export interface ExecutorOptions {
  filters: readonly ToolFilter[];
  handlers: Readonly<Record<string, ToolHandler>>;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
}

export interface Executor {
  execute(call: ToolCall, context: RunContext): Promise<ToolResult>;
}

const POLICY_PREFIXES = [
  'POLICY_BLOCKED',
  'DLP_',
  'TIER_',
  'UNAUTHORIZED',
  'CAPABILITY_',
  'PATH_DENIED',
  'NETWORK_DENIED',
  'EXEC_',
  'IRREVERSIBLE_',
  'RATE_LIMITED',
];

const SEMANTIC_PREFIXES = ['INVALID_', 'VALIDATION_', 'SCHEMA_', 'BAD_', 'HTTP_400', 'HTTP_422'];
const ENVIRONMENT_PREFIXES = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOMEM',
  'ERR_ACCESS_DENIED',
  'SANDBOX_',
  'EAGENT_SKILL_SUBPROCESS',
  'EAGENT_SKILL_LIMIT',
  'EAGENT_SKILL_PATH',
];
const TRANSIENT_PREFIXES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EBUSY',
  'EAGAIN',
  'HTTP_429',
  'HTTP_503',
  'TIMEOUT',
  'TRANSIENT',
];

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function classifyFailure(input: unknown): FailureClass {
  const code =
    typeof input === 'string'
      ? input
      : String((input as { code?: unknown } | null)?.code ?? '');
  const message =
    typeof input === 'string'
      ? input
      : String((input as { message?: unknown } | null)?.message ?? '');
  const combined = `${code} ${message}`.toUpperCase();

  if (startsWithAny(combined, POLICY_PREFIXES)) return 'policy';
  if (startsWithAny(combined, SEMANTIC_PREFIXES)) return 'semantic';
  if (startsWithAny(combined, ENVIRONMENT_PREFIXES)) return 'environment';
  if (startsWithAny(combined, TRANSIENT_PREFIXES)) return 'transient';
  if (/\bTIMEOUT\b|TIMED OUT|RATE LIMIT/.test(combined)) return 'transient';
  return 'unknown';
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === host) return true;
    return pattern.startsWith('*.') && host.endsWith(pattern.slice(1));
  });
}

function withinRoots(target: string, roots: readonly string[], skillDir: string): boolean {
  const resolved = path.resolve(skillDir, target);
  const allowedRoots = roots.length === 0 ? [skillDir] : roots.map((root) => path.resolve(skillDir, root));
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

function declaredCommandMatches(command: string, declared: readonly string[]): boolean {
  const normalized = command.trim();
  return declared.some((entry) => {
    const declaredCommand = entry.trim();
    return normalized === declaredCommand || normalized.startsWith(`${declaredCommand} `);
  });
}

function enforcePermissions(call: ToolCall, context: RunContext): void {
  const manifest = context.skill.manifest;
  const permissions = manifest.permissions;
  const capability = call.capability;

  if (capability.startsWith('exec')) {
    if (!context.ceiling.exec) {
      throw new ExecutionError(
        'TIER_EXEC_DENIED',
        `trust tier ${context.tier} does not permit script execution`,
      );
    }
    const command = String(call.args.command ?? call.args.cmd ?? '');
    if (permissions.exec.length === 0) {
      throw new ExecutionError('EXEC_NOT_DECLARED', 'skill declares no executable commands');
    }
    if (!declaredCommandMatches(command, permissions.exec)) {
      throw new ExecutionError('EXEC_NOT_DECLARED', `command is not declared: ${command}`);
    }
  }

  if (capability.startsWith('net')) {
    if (!context.ceiling.net) {
      throw new ExecutionError('TIER_NET_DENIED', `trust tier ${context.tier} does not permit network`);
    }
    const rawUrl = String(call.args.url ?? '');
    let host = '';
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      host = '';
    }
    if (host.length === 0 || !hostAllowed(host, permissions.net)) {
      throw new ExecutionError('NETWORK_DENIED', `host is not in permissions.net: ${host || '<none>'}`);
    }
  }

  if (capability === 'fs.write') {
    if (context.ceiling.fs === 'skill-read') {
      throw new ExecutionError('TIER_FS_DENIED', `trust tier ${context.tier} is read-only`);
    }
    const target = String(call.args.path ?? call.args.file_path ?? '');
    if (target.length === 0 || !withinRoots(target, permissions.fs, context.skill.dir)) {
      throw new ExecutionError('PATH_DENIED', `write target escapes declared roots: ${target}`);
    }
  }

  if (capability === 'fs.read') {
    const target = String(call.args.path ?? call.args.file_path ?? '');
    if (target.length > 0 && !withinRoots(target, [], context.skill.dir)) {
      throw new ExecutionError('PATH_DENIED', `read target escapes the skill directory: ${target}`);
    }
  }

  if (call.sideEffect === 'irreversible') {
    const declared = permissions.irreversible;
    const named = declared.some(
      (entry) => entry === capability || entry === call.tool || entry === call.capability,
    );
    if (!context.ceiling.irreversible || !named) {
      throw new ExecutionError(
        'IRREVERSIBLE_NOT_DECLARED',
        `irreversible call ${call.tool} is not declared`,
      );
    }
  }
}

/**
 * Execution is always: permission ceiling, filter chain, handler, trace event,
 * then result. Retries follow the fixed failure mapping, never a per-skill rule.
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const sleep = options.sleep ?? defaultSleep;
  const baseDelayMs = options.baseDelayMs ?? 100;

  return {
    async execute(call, context) {
      const normalized: ToolCall = {
        ...call,
        capability: toolFamily(call.tool),
        skill: context.skill.manifest.name,
        runId: context.runId,
      };

      const chain = createFilterChain(options.filters, { tracer: context.tracer });

      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          enforcePermissions(normalized, context);
          const result = await chain.run(normalized, async (current) => {
            const handler = options.handlers[current.tool];
            if (handler === undefined) {
              throw new ExecutionError('NO_HANDLER', `no handler registered for ${current.tool}`);
            }
            const value = await handler(current, context);
            return { ok: true, value };
          });

          if (result.ok) {
            const finalResult = { ...result, meta: { ...result.meta, attempts: attempt } };
            context.tracer.emit('execution.result', {
              callId: call.id,
              tool: call.tool,
              ok: true,
              attempts: attempt,
            });
            return finalResult;
          }

          const failureClass = classifyFailure(result.error?.code ?? 'UNKNOWN');
          const policy = FAILURE_MAPPING[failureClass];
          if (attempt <= policy.retries) {
            const delayMs = baseDelayMs * 2 ** (attempt - 1);
            context.tracer.emit('execution.retry', {
              callId: call.id,
              tool: call.tool,
              failureClass,
              attempt,
              delayMs,
            });
            await sleep(delayMs);
            continue;
          }

          context.tracer.emit('execution.result', {
            callId: call.id,
            tool: call.tool,
            ok: false,
            failureClass,
            attempts: attempt,
          });
          return {
            ...result,
            meta: {
              ...result.meta,
              attempts: attempt,
              failureClass,
              escalated: policy.escalate,
              quarantined: policy.quarantine,
            },
          };
        } catch (error) {
          const failureClass = classifyFailure(error);
          const policy = FAILURE_MAPPING[failureClass];
          const code = error instanceof ExecutionError ? error.code : 'EXECUTION_ERROR';

          if (attempt <= policy.retries) {
            const delayMs = baseDelayMs * 2 ** (attempt - 1);
            context.tracer.emit('execution.retry', {
              callId: call.id,
              tool: call.tool,
              failureClass,
              attempt,
              delayMs,
            });
            await sleep(delayMs);
            continue;
          }

          context.tracer.emit('execution.result', {
            callId: call.id,
            tool: call.tool,
            ok: false,
            failureClass,
            attempts: attempt,
          });
          return {
            ok: false,
            error: { code, message: (error as Error).message },
            meta: {
              attempts: attempt,
              failureClass,
              escalated: policy.escalate,
              quarantined: policy.quarantine,
            },
          };
        }
      }
    },
  };
}
