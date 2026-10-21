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

export const ADAPTER_LIMITATION =
  'hooks-only adapter: it runs after the host loads the skill and cannot prevent host-side `!`command`` preprocessing; only `agent-skill verify` and the standalone runtime cover that moment';

export interface ClaudeHookPayload {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
}

export interface ClaudeHookResult {
  continue: boolean;
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
}

export interface ClaudeAdapterOptions {
  skill: RegisteredSkill;
  filters: readonly ToolFilter[];
  tracer: Tracer;
  caller?: Caller;
}

export interface ClaudeAdapter {
  preToolUse(payload: ClaudeHookPayload): Promise<ClaudeHookResult>;
  postToolUse(payload: ClaudeHookPayload): Promise<ClaudeHookResult>;
  hookConfig(): unknown;
}

function sideEffectOf(tool: string): SideEffect {
  const family = toolFamily(tool);
  if (family === 'fs.read' || family === 'net') return 'readonly';
  if (family === 'fs.write' || family === 'exec' || family === 'task') return 'mutating';
  return 'readonly';
}

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
 * PreToolUse can only gate tools the host is about to run. It cannot undo
 * preprocessing that already happened; that limitation is exported, not hidden.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): ClaudeAdapter {
  let runCounter = 0;
  const chain = createFilterChain(options.filters, { tracer: options.tracer });

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
