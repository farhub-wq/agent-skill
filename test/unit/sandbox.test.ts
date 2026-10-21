/**
 * 沙箱单元测试：命令拆解、写入越界、网络外连、子进程封禁、超时与输出上限。
 * 每个用例在独立临时目录写脚本后真实 spawn。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runSandboxed,
  tokenizeCommand,
  type SandboxLimits,
  type SandboxResult,
} from '../../src/runtime/sandbox.js';
import { createTracer } from '../../src/trace/tracer.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface SandboxRun {
  dir: string;
  result: SandboxResult;
  events: string[];
}

/** 在临时目录写入脚本并执行，返回结果与事件类型序列。 */
async function runScript(
  source: string,
  options: { limits?: Partial<SandboxLimits>; env?: Record<string, string> } = {},
): Promise<SandboxRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-sbx-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'task.mjs'), source, 'utf8');
  const tracer = createTracer();
  const result = await runSandboxed({
    command: 'node task.mjs',
    cwd: dir,
    allowRead: [dir],
    allowWrite: [dir],
    tracer,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { dir, result, events: tracer.events().map((event) => event.type) };
}

describe('command tokenization', () => {
  it('honours quotes', () => {
    expect(tokenizeCommand('node "a b.mjs" \'c\'')).toEqual(['node', 'a b.mjs', 'c']);
    expect(tokenizeCommand('node   task.mjs')).toEqual(['node', 'task.mjs']);
  });

  it('rejects unsupported executables without spawning', async () => {
    const result = await runSandboxed({
      command: 'python task.py',
      cwd: process.cwd(),
      tracer: createTracer(),
    });
    expect(result.unsupported).toBe(true);
    expect(result.stderr).toMatch(/unsupported sandbox executable/);
  });
});

describe('process sandbox', () => {
  it('runs a node script that writes inside the allowed root', async () => {
    const run = await runScript(
      "import fs from 'node:fs'; fs.writeFileSync('out.txt', 'ok'); console.log('done');",
    );
    expect(run.result.ok).toBe(true);
    expect(run.result.stdout).toContain('done');
    expect(run.events).toContain('sandbox.start');
    expect(run.events).toContain('sandbox.end');
    const written = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(run.dir, 'out.txt'), 'utf8'),
    );
    expect(written).toBe('ok');
  });

  it('blocks writes outside the sandbox roots', async () => {
    const run = await runScript(
      "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join('..', 'escape.txt'), 'x');",
    );
    expect(run.result.ok).toBe(false);
    expect(run.result.stderr).toMatch(/EAGENT_SKILL_PATH|ERR_ACCESS_DENIED/);
  });

  it('blocks network egress and emits an event', async () => {
    const run = await runScript(
      "try { await fetch('https://example.com'); console.log('unexpected'); } catch (error) { console.error(error.code); process.exit(3); }",
    );
    expect(run.result.ok).toBe(false);
    expect(run.result.egressBlocked).toBe(true);
    expect(run.result.stderr).toContain('EAGENT_SKILL_EGRESS');
    expect(run.events).toContain('sandbox.egress-blocked');
  });

  it('drops unlisted environment variables', async () => {
    process.env.AGENT_SKILL_TEST_SECRET = 'leaky-value';
    try {
      const run = await runScript(
        "console.log(JSON.stringify({ secret: process.env.AGENT_SKILL_TEST_SECRET ?? null, explicit: process.env.EXPLICIT_VALUE ?? null }));",
        { env: { EXPLICIT_VALUE: 'yes' } },
      );
      expect(run.result.ok).toBe(true);
      expect(run.result.stdout).not.toContain('leaky-value');
      expect(JSON.parse(run.result.stdout.trim())).toEqual({ secret: null, explicit: 'yes' });
    } finally {
      delete process.env.AGENT_SKILL_TEST_SECRET;
    }
  });

  it('kills long-running scripts at the timeout', async () => {
    const run = await runScript('setInterval(() => {}, 1000);', { limits: { timeoutMs: 400 } });
    expect(run.result.ok).toBe(false);
    expect(run.result.timedOut).toBe(true);
  });

  it('kills scripts that exceed the output cap', async () => {
    const run = await runScript("process.stdout.write('x'.repeat(4096));", {
      limits: { maxOutputBytes: 512 },
    });
    expect(run.result.ok).toBe(false);
    expect(run.result.outputLimitExceeded).toBe(true);
  });

  it('blocks child processes', async () => {
    const run = await runScript(
      "import cp from 'node:child_process'; try { cp.spawn(process.execPath, ['-e', 'console.log(1)']); console.log('unexpected'); } catch (error) { console.error(error.code); process.exit(4); }",
    );
    expect(run.result.ok).toBe(false);
    expect(run.result.stderr).toContain('EAGENT_SKILL_SUBPROCESS');
  });
});
