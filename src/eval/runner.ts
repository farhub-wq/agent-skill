import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Tracer } from '../trace/tracer.js';
import type { EvalCase } from './case.js';
import type { Grader, GraderResult } from './grader.js';

export interface EvalTargetResult {
  output: unknown;
  costUsd: number;
  latencyMs: number;
  escalated: boolean;
}

export interface EvalTarget {
  run(testCase: EvalCase): Promise<EvalTargetResult>;
}

export interface EvalAttempt {
  caseId: string;
  attempt: number;
  pass: boolean;
  score: number;
  costUsd: number;
  latencyMs: number;
  escalated: boolean;
  detail?: string;
}

export interface RunnerOptions {
  target: EvalTarget;
  grader: Grader;
  k: number;
  tracer: Tracer;
}

export interface EvalRun {
  attempts: EvalAttempt[];
  cases: Array<{ caseId: string; attempts: EvalAttempt[] }>;
}

/**
 * Every attempt emits start and end events. A failed attempt is evidence, not
 * an exception: the runner keeps going so pass^k stays meaningful.
 */
export async function runEval(cases: readonly EvalCase[], options: RunnerOptions): Promise<EvalRun> {
  const k = Math.max(1, Math.floor(options.k));
  const attempts: EvalAttempt[] = [];
  const grouped: Array<{ caseId: string; attempts: EvalAttempt[] }> = [];

  for (const testCase of cases) {
    const caseAttempts: EvalAttempt[] = [];
    for (let attempt = 1; attempt <= k; attempt += 1) {
      options.tracer.emit('eval.case', {
        phase: 'start',
        caseId: testCase.id,
        attempt,
      });

      const startedAt = Date.now();
      let grade: GraderResult = { pass: false, score: 0 };
      let costUsd = 0;
      let escalated = false;
      let detail: string | undefined;
      let latencyMs = 0;

      try {
        const result = await options.target.run(testCase);
        costUsd = result.costUsd;
        escalated = result.escalated;
        latencyMs = result.latencyMs;
        grade = await options.grader.grade(testCase, result.output);
        detail = grade.detail;
      } catch (error) {
        latencyMs = Date.now() - startedAt;
        detail = (error as Error).message;
      }

      const record: EvalAttempt = {
        caseId: testCase.id,
        attempt,
        pass: grade.pass,
        score: grade.score,
        costUsd,
        latencyMs,
        escalated,
        ...(detail === undefined ? {} : { detail }),
      };
      attempts.push(record);
      caseAttempts.push(record);

      options.tracer.emit('eval.case', {
        phase: 'end',
        caseId: testCase.id,
        attempt,
        pass: grade.pass,
        latencyMs,
      });
    }
    grouped.push({ caseId: testCase.id, attempts: caseAttempts });
  }

  options.tracer.emit('eval.summary', {
    cases: cases.length,
    attempts: attempts.length,
    k,
  });

  return { attempts, cases: grouped };
}

export interface ScriptTargetOptions {
  dir: string;
  command: string;
  timeoutMs?: number;
  /** Local execution has no real model cost; the value is synthetic and labelled so. */
  costPerRunUsd?: number;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function createScriptTarget(options: ScriptTargetOptions): EvalTarget {
  const argv = options.command.trim().split(/\s+/);
  const script = argv[1];
  if (argv[0] !== 'node' || script === undefined) {
    throw new Error(`eval target supports only "node <script>": ${options.command}`);
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const costPerRunUsd = options.costPerRunUsd ?? 0.0002;

  return {
    async run(testCase) {
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [path.resolve(options.dir, script), ...argv.slice(2)], {
        cwd: options.dir,
        input: JSON.stringify(testCase.input),
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1_048_576,
        windowsHide: true,
      });
      const latencyMs = Date.now() - startedAt;
      if (result.error !== undefined) {
        throw new Error(`eval target failed: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(
          `eval target exited ${String(result.status)}: ${(result.stderr ?? '').slice(0, 400)}`,
        );
      }
      return {
        output: parseJsonOutput(result.stdout ?? ''),
        costUsd: costPerRunUsd,
        latencyMs,
        escalated: false,
      };
    },
  };
}
