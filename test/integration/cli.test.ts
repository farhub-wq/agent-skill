/**
 * CLI 集成测试：直接调用 main()，验证退出码、输出、台账与证据文件。
 * 通过捕获 console/stdout 避免污染测试输出。
 */
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { verifyEvidenceLock } from '../../src/evidence/lock.js';
import { readLedger } from '../../src/trace/ledger.js';
import { exampleDir, fixtureDir, repoRoot } from '../helpers.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 捕获的输出句柄：text 取全部内容，restore 还原 console/stdout。 */
interface Capture {
  text: () => string;
  restore: () => void;
}

/** 拦截 console.log/error 与 process.stdout.write，汇总为一段文本。 */
function captureOutput(): Capture {
  const chunks: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map((value) => String(value)).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map((value) => String(value)).join(' '));
  });
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
  return {
    text: () => chunks.join('\n'),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
    },
  };
}

async function cli(args: string[]): Promise<{ code: number; text: string }> {
  const capture = captureOutput();
  try {
    const code = await main(args);
    return { code, text: capture.text() };
  } finally {
    capture.restore();
  }
}

function parseJsonOutput(text: string): unknown {
  const start = text.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(start)) as unknown;
}

describe('CLI admission commands', () => {
  it('verifies the example skill at install gate', async () => {
    const result = await cli(['verify', exampleDir, '--gate', 'install']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('verdict: allow');
  });

  it('rejects a preprocessing command with exit code 2', async () => {
    const result = await cli([
      'verify',
      fixtureDir('malicious', 'preprocessing-command'),
      '--gate',
      'install',
    ]);
    expect(result.code).toBe(2);
    expect(result.text).toContain('preprocessing-command');
    expect(result.text).toContain('verdict: deny');
  });

  it('rejects a community skill at full gate', async () => {
    const result = await cli(['verify', fixtureDir('community-exec'), '--gate', 'full']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('undeclared-tool');
  });

  it('rejects an invalid gate value', async () => {
    const result = await cli(['verify', exampleDir, '--gate', 'deep']);
    expect(result.code).toBe(1);
    expect(result.text).toContain('invalid --gate');
  });

  it('inspects the example as JSON', async () => {
    const result = await cli(['inspect', exampleDir, '--json']);
    expect(result.code).toBe(0);
    const summary = parseJsonOutput(result.text) as {
      name: string;
      trustTier: string;
      ceiling: { exec: boolean };
      scripts: string[];
    };
    expect(summary.name).toBe('invoice-reconcile');
    expect(summary.trustTier).toBe('T4');
    expect(summary.ceiling.exec).toBe(true);
    expect(summary.scripts).toEqual(['scripts/reconcile.mjs']);
  });
});

describe('CLI init and run', () => {
  it('creates a skeleton that passes install admission', async () => {
    const parent = await tempDir('agent-skill-init-');
    const skillDir = path.join(parent, 'demo-skill');
    const init = await cli(['init', skillDir]);
    expect(init.code).toBe(0);

    const verify = await cli(['verify', skillDir, '--gate', 'install']);
    expect(verify.code).toBe(0);
    expect(verify.text).toContain('verdict: allow');
    expect((await stat(path.join(skillDir, 'SKILL.md'))).isFile()).toBe(true);
    expect((await stat(path.join(skillDir, 'skill.yaml'))).isFile()).toBe(true);
  });

  it('runs the example declared command and writes a JSONL ledger', async () => {
    const cwd = await tempDir('agent-skill-run-');
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await cli([
        'run',
        exampleDir,
        '--input',
        path.join(exampleDir, 'data', 'input.json'),
        '--json',
      ]);
      expect(result.code).toBe(0);
      const payload = parseJsonOutput(result.text) as {
        ok: boolean;
        results: Array<{ stdout: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.results[0]?.stdout).toContain('"status":"paid"');

      const ledgerPath = path.join(cwd, '.agent-skill', 'trace.jsonl');
      const events = readLedger(ledgerPath);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('run.start');
      expect(types).toContain('admission.verdict');
      expect(types).toContain('sandbox.start');
      expect(types).toContain('sandbox.end');
      expect(types.at(-1)).toBe('run.end');
      expect(JSON.parse(await readFile(ledgerPath, 'utf8').then((body) => body.split(/\r?\n/)[0] ?? '{}'))).toHaveProperty(
        'runId',
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('refuses to run a community skill at execution time with exit code 3', async () => {
    const cwd = await tempDir('agent-skill-deny-');
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await cli(['run', fixtureDir('community-exec')]);
      expect(result.code).toBe(3);
      expect(result.text).toContain('does not permit script execution');
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('CLI eval', () => {
  it('runs k attempts and writes a locked evidence card', async () => {
    const parent = await tempDir('agent-skill-eval-');
    const skillDir = path.join(parent, 'invoice-reconcile');
    await cp(exampleDir, skillDir, { recursive: true });

    const result = await cli([
      'eval',
      skillDir,
      '--k',
      '2',
      '--now',
      '2026-01-01T00:00:00.000Z',
      '--json',
    ]);
    expect(result.code).toBe(0);

    const payload = parseJsonOutput(result.text) as {
      card: { n: number; 'pass@1': number; gates: Record<string, boolean> };
    };
    expect(payload.card.n).toBe(12);
    expect(payload.card['pass@1']).toBe(1);
    expect(payload.card.gates.G3).toBe(true);

    const evidencePath = path.join(skillDir, 'evidence', 'evidence.json');
    const lockPath = path.join(skillDir, 'evidence', 'evidence.lock');
    expect(await verifyEvidenceLock(evidencePath, lockPath)).toBe(true);
    const card = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    expect(card.data_source).toBe('synthetic');
    expect(card.generated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a negative k value', async () => {
    const result = await cli(['eval', exampleDir, '--k', '0']);
    expect(result.code).toBe(1);
    expect(result.text).toContain('invalid --k');
  });
});

describe('CLI adapter and usage', () => {
  it('prints the Claude hook config with its limitation', async () => {
    const result = await cli(['adapter', 'claude']);
    expect(result.code).toBe(0);
    const config = parseJsonOutput(result.text) as { agentSkillLimitation: string };
    expect(config.agentSkillLimitation).toContain('cannot prevent host-side');
  });

  it('requires a skill directory for hook mode', async () => {
    const result = await cli(['adapter', 'claude', '--hook']);
    expect(result.code).toBe(1);
    expect(result.text).toContain('require --dir');
  });

  it('returns usage errors and help correctly', async () => {
    expect((await cli([])).code).toBe(1);
    expect((await cli(['unknown-command'])).code).toBe(1);
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.text).toContain('别人管「装」');
    expect(help.text).toContain('Sandbox is process-level and is not a security boundary.');
  });

  it('resolves the repository root fixtures from the test tree', () => {
    expect(path.resolve(repoRoot, 'examples', 'invoice-reconcile')).toBe(exampleDir);
  });
});
