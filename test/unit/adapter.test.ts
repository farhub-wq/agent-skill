import { describe, expect, it } from 'vitest';
import {
  ADAPTER_LIMITATION,
  claudeHookConfig,
  createClaudeAdapter,
  type ClaudeHookPayload,
} from '../../src/adapter/claude.js';
import { createDefaultFilters } from '../../src/filters/index.js';
import { createTracer } from '../../src/trace/tracer.js';
import { registeredSkill } from '../helpers.js';

function setup() {
  const skill = registeredSkill({
    capabilities: ['fs.read'],
    permissions: { fs: ['data'] },
  });
  const tracer = createTracer();
  const adapter = createClaudeAdapter({
    skill,
    tracer,
    filters: createDefaultFilters({
      capabilities: skill.manifest.capabilities,
      permissions: skill.manifest.permissions,
      tracer,
    }),
  });
  return { adapter, tracer };
}

function payload(overrides: Partial<ClaudeHookPayload> = {}): ClaudeHookPayload {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    tool_name: 'Read',
    tool_input: { path: 'data/input.json' },
    ...overrides,
  };
}

describe('claude hooks-only adapter', () => {
  it('allows tools the manifest declares', async () => {
    const { adapter, tracer } = setup();
    const result = await adapter.preToolUse(payload());
    expect(result).toEqual({ continue: true, permissionDecision: 'allow' });
    expect(tracer.events().some((event) => event.type === 'adapter.pre-tool-use')).toBe(true);
  });

  it('denies tools outside the declared capabilities', async () => {
    const { adapter } = setup();
    const result = await adapter.preToolUse(
      payload({ tool_name: 'Bash', tool_input: { command: 'curl https://evil.example' } }),
    );
    expect(result.continue).toBe(false);
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain('CAPABILITY_DENIED');
  });

  it('records post tool use observations', async () => {
    const { adapter, tracer } = setup();
    const result = await adapter.postToolUse(
      payload({ hook_event_name: 'PostToolUse', tool_response: { ok: true } }),
    );
    expect(result.permissionDecision).toBe('allow');
    expect(tracer.events().some((event) => event.type === 'adapter.post-tool-use')).toBe(true);
  });

  it('prints a hook configuration for both events', () => {
    const config = claudeHookConfig() as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
      agentSkillLimitation: string;
    };
    expect(Object.keys(config.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    expect(config.hooks.PreToolUse?.[0]?.hooks[0]?.command).toContain('agent-skill adapter claude');
    expect(config.agentSkillLimitation).toBe(ADAPTER_LIMITATION);
  });

  it('states the preprocessing limitation instead of hiding it', () => {
    expect(ADAPTER_LIMITATION).toContain('cannot prevent host-side');
    expect(ADAPTER_LIMITATION).toContain('`!`command`');
  });
});
