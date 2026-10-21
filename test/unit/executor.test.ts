import { describe, expect, it } from 'vitest';
import { createDefaultFilters } from '../../src/filters/index.js';
import { createRunContext } from '../../src/runtime/context.js';
import {
  classifyFailure,
  createExecutor,
  ExecutionError,
  FAILURE_MAPPING,
  type ToolHandler,
} from '../../src/runtime/executor.js';
import { createTracer } from '../../src/trace/tracer.js';
import { registeredSkill, toolCall } from '../helpers.js';

function setup(overrides: Parameters<typeof registeredSkill>[0] = {}) {
  const skill = registeredSkill(
    {
      trust: 'certified',
      capabilities: ['fs.read', 'fs.write', 'exec', 'net'],
      permissions: {
        fs: ['data'],
        exec: ['node scripts/task.mjs'],
        net: ['api.example.com', '*.trusted.example'],
      },
      ...overrides,
    },
    { dir: process.cwd() },
  );
  const tracer = createTracer({ runId: 'executor-run' });
  const context = createRunContext({ skill, tracer });
  return { tracer, context };
}

describe('failure mapping', () => {
  it('is fixed and not configurable per skill', () => {
    expect(FAILURE_MAPPING).toEqual({
      transient: { retries: 3, escalate: false, quarantine: false },
      semantic: { retries: 0, escalate: true, quarantine: false },
      policy: { retries: 0, escalate: true, quarantine: true },
      environment: { retries: 0, escalate: false, quarantine: false },
      unknown: { retries: 1, escalate: true, quarantine: false },
    });
  });

  it('classifies by code prefix', () => {
    expect(classifyFailure('ETIMEDOUT')).toBe('transient');
    expect(classifyFailure('HTTP_503')).toBe('transient');
    expect(classifyFailure('INVALID_AMOUNT')).toBe('semantic');
    expect(classifyFailure('DLP_PII_BLOCKED')).toBe('policy');
    expect(classifyFailure('ENOENT')).toBe('environment');
    expect(classifyFailure('something odd')).toBe('unknown');
  });
});

describe('executor', () => {
  it('executes a declared command and traces the result before returning', async () => {
    const { tracer, context } = setup({}, {
      Bash: async () => ({ status: 'paid' }),
    });
    const executor = createExecutor({ filters: [], handlers: { Bash: async () => ({ status: 'paid' }) } });
    const result = await executor.execute(
      toolCall({
        tool: 'Bash',
        capability: 'exec',
        args: { command: 'node scripts/task.mjs' },
        sideEffect: 'mutating',
      }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ status: 'paid' });
    expect(result.meta?.attempts).toBe(1);
    expect(tracer.events().at(-1)?.type).toBe('execution.result');
    expect(tracer.events().some((event) => event.type === 'tool.before')).toBe(true);
    expect(tracer.events().some((event) => event.type === 'tool.after')).toBe(true);
  });

  it('derives the capability from the tool name instead of trusting the caller', async () => {
    const { context } = setup();
    const executor = createExecutor({
      filters: [],
      handlers: { Bash: async () => 'should not run' },
    });
    const result = await executor.execute(
      toolCall({
        tool: 'Bash',
        capability: 'fs.read',
        args: { command: 'node scripts/task.mjs' },
        sideEffect: 'mutating',
      }),
      context,
    );
    expect(result.ok).toBe(true);

    const community = registeredSkill(
      {
        trust: 'community',
        capabilities: ['fs.read', 'exec'],
        permissions: { exec: ['node scripts/task.mjs'] },
      },
      { dir: process.cwd() },
    );
    const t1Context = createRunContext({ skill: community, tracer: createTracer() });
    const denied = await executor.execute(
      toolCall({ tool: 'Bash', capability: 'fs.read', args: { command: 'node scripts/task.mjs' } }),
      t1Context,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('TIER_EXEC_DENIED');
    expect(denied.meta?.failureClass).toBe('policy');
    expect(denied.meta?.quarantined).toBe(true);
  });

  it('retries transient failures three times with exponential backoff', async () => {
    const delays: number[] = [];
    const handler: ToolHandler = () => {
      const error = new Error('socket timed out');
      (error as Error & { code: string }).code = 'ETIMEDOUT';
      throw error;
    };
    const { tracer, context } = setup();
    const executor = createExecutor({
      filters: [],
      handlers: { Bash: handler },
      baseDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const result = await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/task.mjs' } }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.meta?.attempts).toBe(4);
    expect(result.meta?.failureClass).toBe('transient');
    expect(result.meta?.escalated).toBe(false);
    expect(delays).toEqual([10, 20, 40]);
    expect(tracer.events().filter((event) => event.type === 'execution.retry')).toHaveLength(3);
  });

  it('does not retry semantic failures and escalates them', async () => {
    const handler: ToolHandler = () => {
      const error = new Error('invoice amount is invalid');
      (error as Error & { code: string }).code = 'INVALID_AMOUNT';
      throw error;
    };
    const { context } = setup();
    const executor = createExecutor({
      filters: [],
      handlers: { Bash: handler },
      sleep: async () => {
        throw new Error('sleep must not be called for semantic failures');
      },
    });
    const result = await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/task.mjs' } }),
      context,
    );
    expect(result.meta?.attempts).toBe(1);
    expect(result.meta?.failureClass).toBe('semantic');
    expect(result.meta?.escalated).toBe(true);
  });

  it('does not retry environment failures', async () => {
    const handler: ToolHandler = () => {
      throw new ExecutionError('ENOENT', 'script is missing');
    };
    const { context } = setup();
    const executor = createExecutor({ filters: [], handlers: { Bash: handler } });
    const result = await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/task.mjs' } }),
      context,
    );
    expect(result.meta?.attempts).toBe(1);
    expect(result.meta?.failureClass).toBe('environment');
    expect(result.meta?.escalated).toBe(false);
  });

  it('retries unknown failures once and escalates', async () => {
    const handler: ToolHandler = () => {
      throw new Error('very unusual failure');
    };
    const { context } = setup();
    const executor = createExecutor({
      filters: [],
      handlers: { Bash: handler },
      sleep: async () => {},
    });
    const result = await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/task.mjs' } }),
      context,
    );
    expect(result.meta?.attempts).toBe(2);
    expect(result.meta?.failureClass).toBe('unknown');
    expect(result.meta?.escalated).toBe(true);
  });

  it('denies network hosts outside the allowlist and allows wildcards', async () => {
    const executor = createExecutor({
      filters: [],
      handlers: { WebFetch: async () => 'fetched' },
    });
    const { context } = setup();
    const denied = await executor.execute(
      toolCall({ tool: 'WebFetch', capability: 'net', args: { url: 'https://evil.example/x' } }),
      context,
    );
    expect(denied.error?.code).toBe('NETWORK_DENIED');

    const allowed = await executor.execute(
      toolCall({ tool: 'WebFetch', capability: 'net', args: { url: 'https://cdn.trusted.example/x' } }),
      context,
    );
    expect(allowed.ok).toBe(true);
  });

  it('denies writes outside declared roots and reads outside the skill directory', async () => {
    const executor = createExecutor({
      filters: [],
      handlers: { Write: async () => 'written', Read: async () => 'read' },
    });
    const { context } = setup();

    const write = await executor.execute(
      toolCall({ tool: 'Write', sideEffect: 'mutating', args: { path: '../escape.txt' } }),
      context,
    );
    expect(write.error?.code).toBe('PATH_DENIED');

    const read = await executor.execute(
      toolCall({ tool: 'Read', args: { path: '../outside.txt' } }),
      context,
    );
    expect(read.error?.code).toBe('PATH_DENIED');
  });

  it('runs the default filter chain around the handler', async () => {
    const skill = registeredSkill(
      {
        trust: 'certified',
        capabilities: ['fs.read'],
        permissions: { fs: ['data'] },
      },
      { dir: process.cwd() },
    );
    const tracer = createTracer();
    const context = createRunContext({ skill, tracer });
    const executor = createExecutor({
      filters: createDefaultFilters({
        capabilities: skill.manifest.capabilities,
        permissions: skill.manifest.permissions,
        tracer,
      }),
      handlers: { Read: async () => 'file-content' },
    });
    const result = await executor.execute(toolCall({ args: { path: 'data/input.json' } }), context);

    expect(result.ok).toBe(true);
    expect(result.meta?.audit).toBeDefined();
    expect(tracer.events().filter((event) => event.type === 'audit.record')).toHaveLength(2);
  });
});
