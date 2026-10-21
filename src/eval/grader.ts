/**
 * 评分器：L0 精确匹配、L1 字段级匹配、L2 判定器（默认离线确定性实现）。
 * 评分只依赖用例的 expected，不读取模型自述。
 */
import type { EvalCase } from './case.js';

/** 单次评分结果；score 为 0–1，便于字段级部分得分。 */
export interface GraderResult {
  pass: boolean;
  score: number;
  detail?: string;
}

/** 评分器接口：名称用于报告，grade 返回判定与得分。 */
export interface Grader {
  name: string;
  grade(testCase: EvalCase, output: unknown): GraderResult | Promise<GraderResult>;
}

/** 将任意值序列化为键排序的规范 JSON，用于稳定比较与哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 基于规范 JSON 的深比较，忽略对象键顺序。 */
export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** L0：输出与 expected 完全相等才算通过。 */
export function l0ExactGrader(): Grader {
  return {
    name: 'L0-exact',
    grade(testCase, output) {
      const pass = deepEqual(testCase.expected, output);
      return { pass, score: pass ? 1 : 0, detail: pass ? undefined : 'exact match failed' };
    },
  };
}

/** L1：只比较 expected 中出现的字段，使 fixture 可以保持精简。 */
export function l1FieldGrader(fields: readonly string[]): Grader {
  return {
    name: 'L1-fields',
    grade(testCase, output) {
      if (testCase.expected === null || typeof testCase.expected !== 'object') {
        const pass = deepEqual(testCase.expected, output);
        return { pass, score: pass ? 1 : 0 };
      }
      const expected = testCase.expected as Record<string, unknown>;
      const actual =
        output !== null && typeof output === 'object' ? (output as Record<string, unknown>) : {};
      const checked = fields.filter((field) => Object.hasOwn(expected, field));
      if (checked.length === 0) {
        const pass = deepEqual(expected, actual);
        return { pass, score: pass ? 1 : 0 };
      }
      const matched = checked.filter((field) => deepEqual(expected[field], actual[field]));
      const pass = matched.length === checked.length;
      return {
        pass,
        score: matched.length / checked.length,
        detail: pass ? undefined : `matched ${matched.length}/${checked.length} fields`,
      };
    },
  };
}

/** 自定义判定器：返回 true 表示通过。 */
export type Judge = (testCase: EvalCase, output: unknown) => boolean | Promise<boolean>;

/** L2 通过接口预留；默认判定器是确定性、离线的深比较。 */
export function l2JudgeGrader(judge?: Judge): Grader {
  const resolved: Judge = judge ?? ((testCase, output) => deepEqual(testCase.expected, output));
  return {
    name: 'L2-judge',
    async grade(testCase, output) {
      const pass = await resolved(testCase, output);
      return { pass, score: pass ? 1 : 0, detail: judge === undefined ? 'mock judge' : undefined };
    },
  };
}
