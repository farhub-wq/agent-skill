/**
 * 工具执行器：权限天花板检查 → 过滤链 → 处理器 → 固定失败映射重试。
 * 重试语义由框架固定，技能作者不能自定义。
 */
import path from 'node:path';
import { toolFamily } from '../admission/skill-md.js';
import {
  createFilterChain,
  type ToolCall,
  type ToolFilter,
  type ToolResult,
} from '../filters/chain.js';
import type { RunContext } from './context.js';

/** 失败分类：决定重试次数、是否升级、是否隔离。 */
export type FailureClass = 'transient' | 'semantic' | 'policy' | 'environment' | 'unknown';

/** 单一失败类的处置策略。 */
export interface FailurePolicy {
  /** 最大重试次数（不含首次执行）。 */
  retries: number;
  /** 是否上报给上层人工/代理处理。 */
  escalate: boolean;
  /** 是否将技能标记为隔离，禁止后续调用。 */
  quarantine: boolean;
}

/** 固定映射：技能作者不能自选重试语义。 */
export const FAILURE_MAPPING: Readonly<Record<FailureClass, FailurePolicy>> = Object.freeze({
  transient: { retries: 3, escalate: false, quarantine: false },
  semantic: { retries: 0, escalate: true, quarantine: false },
  policy: { retries: 0, escalate: true, quarantine: true },
  environment: { retries: 0, escalate: false, quarantine: false },
  unknown: { retries: 1, escalate: true, quarantine: false },
});

/** 带稳定错误码的执行错误，错误码会参与失败分类。 */
export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/** 工具处理器：由宿主注入，返回值会被包装成 ok 结果。 */
export type ToolHandler = (
  call: ToolCall,
  context: RunContext,
) => Promise<unknown> | unknown;

export interface ExecutorOptions {
  /** 过滤链上的过滤器，顺序由各自 order 决定。 */
  filters: readonly ToolFilter[];
  /** 工具名到处理器的映射。 */
  handlers: Readonly<Record<string, ToolHandler>>;
  /** 可注入的 sleep，测试中用于避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 指数退避的基础延时，默认 100ms。 */
  baseDelayMs?: number;
}

export interface Executor {
  /** 执行一次工具调用；所有失败都会转为 ToolResult，不向外抛错。 */
  execute(call: ToolCall, context: RunContext): Promise<ToolResult>;
}

// 以下四组前缀决定失败分类；顺序即优先级：policy > semantic > environment > transient。
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

/** 判断字符串是否以任一前缀开头。 */
function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * 根据错误码/错误消息分类，供固定失败映射使用。
 * 无法识别时归为 unknown，宁可少重试也不无限重试。
 */
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

/** 默认休眠实现，可被测试注入替换。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 主机是否命中白名单；支持 *.example.com 形式的通配。 */
function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === host) return true;
    return pattern.startsWith('*.') && host.endsWith(pattern.slice(1));
  });
}

/** 目标路径 resolve 后是否仍在允许的根目录内；roots 为空时只允许技能目录。 */
function withinRoots(target: string, roots: readonly string[], skillDir: string): boolean {
  const resolved = path.resolve(skillDir, target);
  const allowedRoots = roots.length === 0 ? [skillDir] : roots.map((root) => path.resolve(skillDir, root));
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

/** 命令必须与声明完全一致，或以“声明 + 空格”开头，防止前缀拼接绕过。 */
function declaredCommandMatches(command: string, declared: readonly string[]): boolean {
  const normalized = command.trim();
  return declared.some((entry) => {
    const declaredCommand = entry.trim();
    return normalized === declaredCommand || normalized.startsWith(`${declaredCommand} `);
  });
}

/**
 * 运行时权限硬检查：分级上限 + 清单声明。
 * 这是过滤链之前的最后一道保险，任何不匹配都抛 ExecutionError。
 */
function enforcePermissions(call: ToolCall, context: RunContext): void {
  const manifest = context.skill.manifest;
  const permissions = manifest.permissions;
  const capability = call.capability;

  // exec 族：分级允许 + 命令在 permissions.exec 中逐条声明。
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

  // net 族：分级允许 + 主机命中 permissions.net 白名单。
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

  // 写文件：只读分级直接拒绝；其余必须落在声明根目录内。
  if (capability === 'fs.write') {
    if (context.ceiling.fs === 'skill-read') {
      throw new ExecutionError('TIER_FS_DENIED', `trust tier ${context.tier} is read-only`);
    }
    const target = String(call.args.path ?? call.args.file_path ?? '');
    if (target.length === 0 || !withinRoots(target, permissions.fs, context.skill.dir)) {
      throw new ExecutionError('PATH_DENIED', `write target escapes declared roots: ${target}`);
    }
  }

  // 读文件：只允许技能目录内部。
  if (capability === 'fs.read') {
    const target = String(call.args.path ?? call.args.file_path ?? '');
    if (target.length > 0 && !withinRoots(target, [], context.skill.dir)) {
      throw new ExecutionError('PATH_DENIED', `read target escapes the skill directory: ${target}`);
    }
  }

  // 不可逆操作：分级必须允许，且能力/工具名必须在 irreversible 中声明。
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
 * 创建执行器。
 * 固定顺序：权限天花板 → 过滤链 → 处理器 → 事件记录 → 结果；
 * 重试严格遵循固定失败映射，不采用技能自定义规则。
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const sleep = options.sleep ?? defaultSleep;
  const baseDelayMs = options.baseDelayMs ?? 100;

  return {
    async execute(call, context) {
      // 归一化调用：能力族由工具名推导，技能名与 runId 以上下文为准。
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
          // 每次重试都重新做权限检查，避免状态变化后的越权。
          enforcePermissions(normalized, context);
          const result = await chain.run(normalized, async (current) => {
            const handler = options.handlers[current.tool];
            if (handler === undefined) {
              throw new ExecutionError('NO_HANDLER', `no handler registered for ${current.tool}`);
            }
            const value = await handler(current, context);
            return { ok: true, value };
          });

          // 过滤链返回 ok：记录尝试次数并输出成功事件。
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

          // 过滤器返回失败结果：同样按固定映射决定是否重试。
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
