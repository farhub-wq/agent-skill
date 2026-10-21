/**
 * 评测执行器：对每个用例重复 k 次，调用目标与评分器并记录事件。
 * 单次失败只作为证据记录，不中断整体评测，保证 pass^k 有意义。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Tracer } from '../trace/tracer.js';
import type { EvalCase } from './case.js';
import type { Grader, GraderResult } from './grader.js';

/** 被测目标一次运行的输出与成本指标。 */
export interface EvalTargetResult {
  output: unknown;
  costUsd: number;
  latencyMs: number;
  escalated: boolean;
}

/** 被测目标接口：可以是真实模型、脚本或 mock。 */
export interface EvalTarget {
  run(testCase: EvalCase): Promise<EvalTargetResult>;
}

/** 一次尝试的完整记录，最终写入证据卡。 */
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
  /** 每个用例重复次数，至少 1。 */
  k: number;
  tracer: Tracer;
}

/** 评测结果：平铺的 attempts 与按用例分组的 cases。 */
export interface EvalRun {
  attempts: EvalAttempt[];
  cases: Array<{ caseId: string; attempts: EvalAttempt[] }>;
}

/**
 * 执行评测。
 * 每次尝试都发 start/end 事件；失败尝试是证据而不是异常，
 * 执行器会继续跑完，保证 pass^k 统计完整。
 */
export async function runEval(cases: readonly EvalCase[], options: RunnerOptions): Promise<EvalRun> {
  const k = Math.max(1, Math.floor(options.k));
  const attempts: EvalAttempt[] = [];
  const grouped: Array<{ caseId: string; attempts: EvalAttempt[] }> = [];

  for (const testCase of cases) {
    const caseAttempts: EvalAttempt[] = [];
    // 同一用例连续跑 k 次，用于统计 pass^k。
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
        // 目标或评分器抛错：记为一次失败尝试，不中断后续用例。
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
  /** 脚本所在目录，同时作为 cwd。 */
  dir: string;
  /** 仅支持 "node <script>" 形式。 */
  command: string;
  timeoutMs?: number;
  /** 本地执行没有真实模型成本，该值为合成值并在证据中标注。 */
  costPerRunUsd?: number;
}

/** 尝试把 stdout 解析为 JSON；不是 JSON 就原样返回字符串。 */
function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/** 创建脚本型目标：把用例 input 以 JSON 写入 stdin，读取 stdout 作为输出。 */
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
      // 同步 spawn 简化实现；超时与输出上限由 spawnSync 参数控制。
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
