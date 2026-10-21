import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCases, parseEvalCase } from '../../src/eval/case.js';
import {
  canonicalJson,
  deepEqual,
  l0ExactGrader,
  l1FieldGrader,
  l2JudgeGrader,
} from '../../src/eval/grader.js';
import { computeMetrics, wilsonInterval } from '../../src/eval/metrics.js';
import { runEval } from '../../src/eval/runner.js';
import { createTracer } from '../../src/trace/tracer.js';
import { exampleDir } from '../helpers.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('eval cases', () => {
  it('loads the 12 example cases with unique ids', async () => {
    const cases = await loadCases(path.join(exampleDir, 'cases'));
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(12);
    expect(cases.filter((testCase) => testCase.negative)).toHaveLength(4);
  });

  it('rejects duplicated ids across files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-cases-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'a.json'), JSON.stringify([{ id: 'dup', input: 1, expected: 1 }]));
    await writeFile(path.join(dir, 'b.json'), JSON.stringify([{ id: 'dup', input: 2, expected: 2 }]));
    await expect(loadCases(dir)).rejects.toThrow(/duplicate eval case id/);
  });

  it('applies schema defaults', () => {
    const testCase = parseEvalCase({ id: 'x', input: {}, expected: {} });
    expect(testCase.tags).toEqual([]);
    expect(testCase.negative).toBe(false);
    expect(() => parseEvalCase({ input: {} })).toThrow(/invalid eval case/);
  });
});

describe('graders', () => {
  it('L0 compares canonical JSON regardless of key order', async () => {
    const grader = l0ExactGrader();
    const testCase = parseEvalCase({ id: 'x', input: null, expected: { a: 1, b: [2, 3] } });
    expect((await grader.grade(testCase, { b: [2, 3], a: 1 })).pass).toBe(true);
    expect((await grader.grade(testCase, { a: 2, b: [2, 3] })).pass).toBe(false);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(deepEqual({ a: [1] }, { a: [1] })).toBe(true);
  });

  it('L1 compares only the declared fields and reports partial scores', async () => {
    const grader = l1FieldGrader(['status', 'outstanding']);
    const testCase = parseEvalCase({
      id: 'x',
      input: null,
      expected: { status: 'paid', outstanding: 0 },
    });
    expect(
      (await grader.grade(testCase, { status: 'paid', outstanding: 0, extra: true })).pass,
    ).toBe(true);
    const partial = await grader.grade(testCase, { status: 'paid', outstanding: 5 });
    expect(partial.pass).toBe(false);
    expect(partial.score).toBe(0.5);
  });

  it('L2 uses a deterministic mock judge by default', async () => {
    const testCase = parseEvalCase({ id: 'x', input: null, expected: { ok: true } });
    const mock = l2JudgeGrader();
    const mockResult = await mock.grade(testCase, { ok: true });
    expect(mockResult.pass).toBe(true);
    expect(mockResult.detail).toBe('mock judge');

    let calls = 0;
    const custom = l2JudgeGrader(() => {
      calls += 1;
      return false;
    });
    expect((await custom.grade(testCase, { ok: true })).pass).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('eval runner', () => {
  const cases = [
    parseEvalCase({ id: 'a', input: { n: 1 }, expected: { echo: 1 } }),
    parseEvalCase({ id: 'b', input: { n: 2 }, expected: { echo: 2 } }),
  ];

  it('runs k attempts per case and traces every attempt', async () => {
    const tracer = createTracer();
    const run = await runEval(cases, {
      target: {
        run: async (testCase) => ({
          output: testCase.expected,
          costUsd: 0.001,
          latencyMs: 5,
          escalated: false,
        }),
      },
      grader: l0ExactGrader(),
      k: 2,
      tracer,
    });

    expect(run.attempts).toHaveLength(4);
    expect(run.cases).toHaveLength(2);
    expect(run.attempts.every((attempt) => attempt.pass)).toBe(true);
    const events = tracer.events();
    expect(events.filter((event) => event.type === 'eval.case')).toHaveLength(8);
    expect(events.filter((event) => event.type === 'eval.summary')).toHaveLength(1);
  });

  it('records failures as evidence and keeps going', async () => {
    const tracer = createTracer();
    const run = await runEval(cases, {
      target: {
        run: async (testCase) => {
          if (testCase.id === 'b') throw new Error('target exploded');
          return { output: testCase.expected, costUsd: 0, latencyMs: 1, escalated: true };
        },
      },
      grader: l0ExactGrader(),
      k: 1,
      tracer,
    });

    expect(run.attempts).toHaveLength(2);
    const failed = run.attempts.find((attempt) => attempt.caseId === 'b');
    expect(failed?.pass).toBe(false);
    expect(failed?.detail).toContain('target exploded');
    const metrics = computeMetrics(run.cases);
    expect(metrics.knownFailures).toEqual(['b']);
    expect(metrics.escalationRate).toBe(0.5);
  });
});

describe('metrics', () => {
  it('computes pass@1, Wilson interval, pass^k, cost and p95', () => {
    const metrics = computeMetrics([
      {
        caseId: 'a',
        attempts: [
          { pass: true, costUsd: 1, latencyMs: 10, escalated: false },
          { pass: true, costUsd: 1, latencyMs: 20, escalated: false },
        ],
      },
      {
        caseId: 'b',
        attempts: [
          { pass: false, costUsd: 1, latencyMs: 30, escalated: true },
          { pass: true, costUsd: 1, latencyMs: 40, escalated: false },
        ],
      },
    ]);

    expect(metrics.n).toBe(2);
    expect(metrics.totalAttempts).toBe(4);
    expect(metrics.successes).toBe(3);
    expect(metrics['pass@1']).toBe(0.75);
    expect(metrics['pass^k']).toBe(0.5);
    expect(metrics.costPerSuccess).toBeCloseTo(4 / 3, 10);
    expect(metrics.p95LatencyMs).toBe(40);
    expect(metrics.escalationRate).toBe(0.25);
    expect(metrics.knownFailures).toEqual(['b']);
  });

  it('matches the reference Wilson interval', () => {
    const [low, high] = wilsonInterval(8, 10);
    expect(low).toBeCloseTo(0.4902, 3);
    expect(high).toBeCloseTo(0.9433, 3);
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });

  it('returns zeros for an empty run', () => {
    const metrics = computeMetrics([]);
    expect(metrics.n).toBe(0);
    expect(metrics['pass@1']).toBe(0);
    expect(metrics['pass^k']).toBe(0);
    expect(metrics.p95LatencyMs).toBe(0);
    expect(metrics.knownFailures).toEqual([]);
  });
});
