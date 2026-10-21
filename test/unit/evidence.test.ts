import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildEvidenceCard,
  hashSkillDir,
  type EvidenceCard,
} from '../../src/eval/evidence.js';
import { computeMetrics } from '../../src/eval/metrics.js';
import {
  sha256Hex,
  stableStringify,
  verifyEvidenceLock,
  writeEvidenceFiles,
} from '../../src/evidence/lock.js';
import { exampleDir } from '../helpers.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const metrics = computeMetrics([
  {
    caseId: 'a',
    attempts: [{ pass: true, costUsd: 0.001, latencyMs: 12, escalated: false }],
  },
]);

function card(): EvidenceCard {
  return {
    skill: 'demo-skill',
    version: '1.0.0',
    integrity: 'sha256:abc',
    data_source: 'synthetic',
    n: metrics.n,
    'pass@1': metrics['pass@1'],
    pass_at_1_ci95: metrics.passAt1Ci95,
    'pass^k': metrics['pass^k'],
    cost_per_success: metrics.costPerSuccess,
    p95_latency: metrics.p95LatencyMs,
    escalation_rate: metrics.escalationRate,
    known_failures: metrics.knownFailures,
    gates: { G1: true, G2: true, G3: 'skipped', G4: 'skipped' },
    trust_tier: 'T2',
    model_matrix: ['synthetic:mock'],
    harness_version: '0.3.0',
    generated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('stable hashing', () => {
  it('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('matches the known sha256 for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes every shipped file and detects changes', async () => {
    const dir = await tempDir('agent-skill-hash-');
    await writeFile(path.join(dir, 'a.txt'), 'one');
    const first = await hashSkillDir(dir);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await hashSkillDir(dir)).toBe(first);

    await writeFile(path.join(dir, 'b.txt'), 'two');
    const second = await hashSkillDir(dir);
    expect(second).not.toBe(first);

    expect(await hashSkillDir(exampleDir)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('evidence files', () => {
  it('writes evidence.json plus a verifiable lock', async () => {
    const dir = await tempDir('agent-skill-evidence-');
    const written = await writeEvidenceFiles(dir, card());

    expect(written.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyEvidenceLock(written.evidencePath, written.lockPath)).toBe(true);

    const lock = JSON.parse(await readFile(written.lockPath, 'utf8')) as Record<string, unknown>;
    expect(lock.algorithm).toBe('sha256');
    expect(lock.file).toBe('evidence.json');
    expect(lock.digest).toBe(written.digest);
  });

  it('detects a tampered evidence card', async () => {
    const dir = await tempDir('agent-skill-tamper-');
    const written = await writeEvidenceFiles(dir, card());
    const tampered = { ...card(), 'pass@1': 0 };
    await writeFile(written.evidencePath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(await verifyEvidenceLock(written.evidencePath, written.lockPath)).toBe(false);
  });

  it('detects an unsupported lock algorithm', async () => {
    const dir = await tempDir('agent-skill-lock-');
    const written = await writeEvidenceFiles(dir, card());
    const lock = JSON.parse(await readFile(written.lockPath, 'utf8')) as Record<string, unknown>;
    await writeFile(written.lockPath, `${JSON.stringify({ ...lock, algorithm: 'md5' })}\n`);
    expect(await verifyEvidenceLock(written.evidencePath, written.lockPath)).toBe(false);
  });
});

describe('evidence card', () => {
  it('contains exactly the documented fields', async () => {
    const built = await buildEvidenceCard({
      skill: 'invoice-reconcile',
      version: '1.0.0',
      dir: exampleDir,
      trustTier: 'T4',
      metrics,
      gates: { G1: true, G2: true, G3: true, G4: true },
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      harnessVersion: '0.3.0',
    });

    expect(Object.keys(built).sort()).toEqual([
      'cost_per_success',
      'data_source',
      'escalation_rate',
      'gates',
      'generated_at',
      'harness_version',
      'integrity',
      'known_failures',
      'model_matrix',
      'n',
      'p95_latency',
      'pass@1',
      'pass^k',
      'pass_at_1_ci95',
      'skill',
      'trust_tier',
      'version',
    ]);
    expect(built.data_source).toBe('synthetic');
    expect(built.integrity).toBe(await hashSkillDir(exampleDir));
    expect(built.model_matrix).toEqual(['synthetic:mock']);
    expect(built.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(built.gates.G3).toBe(true);
  });
});
