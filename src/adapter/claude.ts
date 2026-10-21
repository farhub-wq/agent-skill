/**
 * Claude Code hooks 适配器：在 PreToolUse 阶段把工具调用送进过滤链。
 * 只能约束宿主即将执行的工具，无法撤销已经发生的 `!`command` 预处理，
 * 这一限制通过 ADAPTER_LIMITATION 显式导出而不是隐藏。
 */
import { toolFamily } from '../admission/skill-md.js';
import {
  createFilterChain,
  type Caller,
  type SideEffect,
  type ToolCall,
  type ToolFilter,
} from '../filters/chain.js';
import type { RegisteredSkill } from '../registry/scope.js';
import type { Tracer } from '../trace/tracer.js';

/** 适配器的能力边界说明，会随 hookConfig 一起输出。 */
export const ADAPTER_LIMITATION =
  'hooks-only adapter: it runs after the host loads the skill and cannot prevent host-side `!`command`` preprocessing; only `agent-skill verify` and the standalone runtime cover that moment';

/** Claude Code hook 传入的 JSON 负载。 */
export interface ClaudeHookPayload {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
}

/** 返回给宿主的决策；deny 时附带原因。 */
export interface ClaudeHookResult {
  continue: boolean;
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
}

export interface ClaudeAdapterOptions {
  /** 当前受保护的技能。 */
  skill: RegisteredSkill;
  /** 复用的过滤器集合，顺序由 order 决定。 */
  filters: readonly ToolFilter[];
  tracer: Tracer;
  /** 未提供时用 claude:<sessionId> 作为调用方。 */
  caller?: Caller;
}

/** 适配器接口：pre 负责拦截，post 只记录，hookConfig 生成宿主配置。 */
export interface ClaudeAdapter {
  preToolUse(payload: ClaudeHookPayload): Promise<ClaudeHookResult>;
  postToolUse(payload: ClaudeHookPayload): Promise<ClaudeHookResult>;
  hookConfig(): unknown;
}

/** 根据工具族推断副作用等级；未知工具按只读处理，写类与执行类为 mutating。 */
function sideEffectOf(tool: string): SideEffect {
  const family = toolFamily(tool);
  if (family === 'fs.read' || family === 'net') return 'readonly';
  if (family === 'fs.write' || family === 'exec' || family === 'task') return 'mutating';
  return 'readonly';
}

/** 生成 Claude Code hooks 配置片段，Pre/Post 都指向同一命令行。 */
export function claudeHookConfig(): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'agent-skill adapter claude --dir <skill-dir> --hook' }],
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'agent-skill adapter claude --dir <skill-dir> --hook' }],
        },
      ],
    },
    agentSkillLimitation: ADAPTER_LIMITATION,
  };
}

/**
 * 创建 Claude 适配器。
 * PreToolUse 只能拦截宿主即将运行的工具，无法撤销已经发生的预处理；
 * 该限制是公开导出的，而不是隐藏的。
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): ClaudeAdapter {
  let runCounter = 0;
  const chain = createFilterChain(options.filters, { tracer: options.tracer });

  /** 把 hook 负载转换为统一的 ToolCall；id 用会话号 + 自增序号保证唯一。 */
  function toCall(payload: ClaudeHookPayload): ToolCall {
    runCounter += 1;
    return {
      id: `${payload.session_id}:${runCounter}`,
      tool: payload.tool_name,
      capability: toolFamily(payload.tool_name),
      args: payload.tool_input,
      sideEffect: sideEffectOf(payload.tool_name),
      caller: options.caller ?? { id: `claude:${payload.session_id}`, roles: ['agent'] },
      skill: options.skill.manifest.name,
      runId: options.tracer.runId,
    };
  }

  return {
    async preToolUse(payload) {
      const call = toCall(payload);
      options.tracer.emit('adapter.pre-tool-use', {
        tool: payload.tool_name,
        sessionId: payload.session_id,
      });
      // 终端处理器不执行工具，只返回 allow；真正执行由宿主完成。
      const result = await chain.run(call, async () => ({ ok: true, value: { decision: 'allow' } }));
      if (result.ok) {
        return { continue: true, permissionDecision: 'allow' };
      }
      return {
        continue: false,
        permissionDecision: 'deny',
        permissionDecisionReason: result.error?.message ?? 'blocked by agent-skill filters',
      };
    },
    async postToolUse(payload) {
      // 工具已执行，只能记录事件；结果审计由审计过滤器负责。
      options.tracer.emit('adapter.post-tool-use', {
        tool: payload.tool_name,
        sessionId: payload.session_id,
      });
      return { continue: true, permissionDecision: 'allow' };
    },
    hookConfig() {
      return claudeHookConfig();
    },
  };
}
