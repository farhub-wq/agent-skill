/**
 * 端到端集成测试：准入 → 注册 → 执行器/过滤链 → 沙箱 → 生命周期 → 评测 → 台账。
 * 验证各模块拼起来后的真实行为，不依赖 mock 宿主。
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runAdmission } from '../../src/admission/gate.js';
import { evalCommand } from '../../src/cli/commands/eval.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { createClaudeAdapter } from '../../src/adapter/claude.js';
import { createFilterChain } from '../../src/filters/chain.js';
import { createDefaultFilters } from '../../src/filters/index.js';
import { runEval } from '../../src/eval/runner.js';
import { l0ExactGrader } from '../../src/eval/grader.js';
import { parseEvalCase } from '../../src/eval/case.js';
import { runPostProcessors } from '../../src/lifecycle/post-processor.js';
import { createLifecycle } from '../../src/lifecycle/skill.js';
import { loadSkillSource } from '../../src/manifest/parse.js';
import { createRegistry, toRegisteredSkill } from '../../src/registry/registry.js';
import { createRunContext } from '../../src/runtime/context.js';
import {
  createExecutor,
  ExecutionError,
  type ToolHandler,
} from '../../src/runtime/executor.js';
import { runSandboxed } from '../../src/runtime/sandbox.js';
import { createSupervisor } from '../../src/runtime/supervisor.js';
import { readLedger } from '../../src/trace/ledger.js';
import { TRACE_EVENT_TYPES } from '../../src/trace/events.js';
import { createTracer } from '../../src/trace/tracer.js';
import { exampleDir, fixtureDir, registeredSkill, toolCall } from '../helpers.js';

// 所有临时目录统一登记，afterAll 时一次性清理。
const tempDirs: string[] = [];

/** 创建临时目录并纳入清理列表。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('standalone runtime pipeline', () => {
  it('executes the example command through filters and the sandbox', async () => {
    const source = await loadSkillSource(exampleDir);
    const tracer = createTracer({ runId: 'pipeline' });
    const admission = await runAdmission(source, { gate: 'install', tracer });
    expect(admission.verdict).toBe('allow');

    const skill = toRegisteredSkill(source.manifest, source.dir, 'task');
    createRegistry([skill]).resolve(skill.manifest.name);
    const context = createRunContext({ skill, tracer });
    const input = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(exampleDir, 'data', 'input.json'), 'utf8'),
    );

    const bashHandler: ToolHandler = async (call, runContext) => {
      const sandboxResult = await runSandboxed({
        command: String(call.args.command),
        cwd: source.dir,
        allowRead: [source.dir],
        allowWrite: [source.dir],
        stdin: input,
        tracer: runContext.tracer,
      });
      if (!sandboxResult.ok) {
        throw new ExecutionError('SANDBOX_FAILED', sandboxResult.stderr);
      }
      return JSON.parse(sandboxResult.stdout) as unknown;
    };

    const executor = createExecutor({
      filters: createDefaultFilters({
        capabilities: source.manifest.capabilities,
        permissions: source.manifest.permissions,
        tracer,
      }),
      handlers: { Bash: bashHandler },
    });
    const result = await executor.execute(
      toolCall({
        tool: 'Bash',
        args: { command: 'node scripts/reconcile.mjs' },
        sideEffect: 'mutating',
        caller: { id: 'integration', roles: ['agent'] },
      }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ invoiceId: 'INV-1001', status: 'paid', outstanding: 0 });

    const types = tracer.events().map((event) => event.type);
    expect(types).toContain('tool.before');
    expect(types).toContain('audit.record');
    expect(types).toContain('sandbox.start');
    expect(types).toContain('sandbox.end');
    expect(types.at(-1)).toBe('execution.result');
    expect(types.indexOf('tool.before')).toBeLessThan(types.indexOf('execution.result'));
  });

  it('denies script execution for a community skill at runtime', async () => {
    const source = await loadSkillSource(fixtureDir('community-exec'));
    const tracer = createTracer({ runId: 'tier-denied' });
    const skill = toRegisteredSkill(source.manifest, source.dir, 'task');
    const context = createRunContext({ skill, tracer });
    const executor = createExecutor({
      filters: [],
      handlers: { Bash: async () => 'should never run' },
    });
    const result = await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/task.mjs' }, sideEffect: 'mutating' }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIER_EXEC_DENIED');
    expect(result.meta?.failureClass).toBe('policy');
    expect(result.meta?.quarantined).toBe(true);
    expect(tracer.events().some((event) => event.type === 'sandbox.start')).toBe(false);
  });
});

describe('trace coverage', () => {
  it('emits every declared event type across real operations', async () => {
    const seen = new Set<string>();
    const tracer = createTracer({ runId: 'trace-coverage' });
    const collect = (): void => {
      for (const event of tracer.events()) seen.add(event.type);
    };

    const source = await loadSkillSource(exampleDir);
    await runAdmission(source, { gate: 'install', tracer });

    const lifecycle = createLifecycle({ skill: source.manifest.name, tracer });
    await lifecycle.transition('admitted');
    await lifecycle.transition('loaded');
    await lifecycle.transition('active');
    await lifecycle.transition('disposed');

    await runPostProcessors(
      { skill: registeredSkill(), content: 'start', tracer },
      [{ name: 'passthrough', order: 10, process: (context) => context }],
    );

    const skill = toRegisteredSkill(source.manifest, source.dir, 'task');
    const context = createRunContext({ skill, tracer });
    const filters = createDefaultFilters({
      capabilities: source.manifest.capabilities,
      permissions: source.manifest.permissions,
      tracer,
    });
    const handlers: Record<string, ToolHandler> = {
      Read: async () => 'ok',
      Bash: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('timed out');
            (error as Error & { code: string }).code = 'ETIMEDOUT';
            throw error;
          }
          return 'ok';
        };
      })(),
    };
    const executor = createExecutor({
      filters,
      handlers,
      sleep: async () => {},
      baseDelayMs: 1,
    });
    await executor.execute(toolCall({ args: { path: 'SKILL.md' } }), context);
    await executor.execute(toolCall({ tool: 'Task', capability: 'task' }), context);
    await executor.execute(
      toolCall({ tool: 'Bash', args: { command: 'node scripts/reconcile.mjs' }, sideEffect: 'mutating' }),
      context,
    );

    const failOpen = createFilterChain(
      [
        {
          name: 'flaky',
          order: 10,
          async before() {
            throw new Error('accidental');
          },
        },
      ],
      { tracer },
    );
    await failOpen.run(toolCall(), async () => ({ ok: true }));

    let attempts = 0;
    const supervisor = createSupervisor({ tracer, sleep: async () => {} });
    await supervisor.run('coverage', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('crashed');
      return 'ok';
    });

    await runEval([parseEvalCase({ id: 'coverage-case', input: null, expected: { ok: true } })], {
      target: {
        run: async () => ({ output: { ok: true }, costUsd: 0, latencyMs: 1, escalated: false }),
      },
      grader: l0ExactGrader(),
      k: 1,
      tracer,
    });

    const adapter = createClaudeAdapter({ skill, filters: [], tracer });
    await adapter.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session',
      tool_name: 'Read',
      tool_input: {},
    });
    await adapter.postToolUse({
      hook_event_name: 'PostToolUse',
      session_id: 'session',
      tool_name: 'Read',
      tool_input: {},
    });

    const sandboxDir = await tempDir('agent-skill-egress-');
    await writeFile(
      path.join(sandboxDir, 'egress.mjs'),
      "try { await fetch('https://example.com'); } catch (error) { console.error(error.code); process.exit(1); }",
    );
    await runSandboxed({
      command: 'node egress.mjs',
      cwd: sandboxDir,
      allowRead: [sandboxDir],
      allowWrite: [sandboxDir],
      tracer,
    });

    const evalDir = path.join(await tempDir('agent-skill-eval-trace-'), 'invoice-reconcile');
    await cp(exampleDir, evalDir, { recursive: true });
    const evalWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let evalCode = 0;
    try {
      evalCode = await evalCommand({
        dir: evalDir,
        k: 1,
        now: '2026-01-01T00:00:00.000Z',
        json: true,
        tracer,
      });
    } finally {
      evalWrite.mockRestore();
    }
    expect(evalCode).toBe(0);
    collect();

    const cwd = await tempDir('agent-skill-run-trace-');
    const originalCwd = process.cwd();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.chdir(cwd);
    try {
      const code = await runCommand({
        dir: exampleDir,
        input: path.join(exampleDir, 'data', 'input.json'),
        json: true,
      });
      expect(code).toBe(0);
    } finally {
      process.chdir(originalCwd);
      write.mockRestore();
    }
    for (const event of readLedger(path.join(cwd, '.agent-skill', 'trace.jsonl'))) {
      seen.add(event.type);
    }
    collect();

    expect([...seen].sort()).toEqual([...TRACE_EVENT_TYPES].sort());
  });
});
