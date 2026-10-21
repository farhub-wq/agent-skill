import type { EvalCase } from './case.js';

export interface GraderResult {
  pass: boolean;
  score: number;
  detail?: string;
}

export interface Grader {
  name: string;
  grade(testCase: EvalCase, output: unknown): GraderResult | Promise<GraderResult>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function l0ExactGrader(): Grader {
  return {
    name: 'L0-exact',
    grade(testCase, output) {
      const pass = deepEqual(testCase.expected, output);
      return { pass, score: pass ? 1 : 0, detail: pass ? undefined : 'exact match failed' };
    },
  };
}

/** Compares only the fields present in `expected`, which keeps fixtures small. */
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

export type Judge = (testCase: EvalCase, output: unknown) => boolean | Promise<boolean>;

/** L2 exists behind an interface; the default judge is deterministic and offline. */
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
