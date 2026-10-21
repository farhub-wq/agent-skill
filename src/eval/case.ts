/**
 * 评测用例：从目录加载 JSON 用例并做结构校验。
 * 用例文件可以是单个对象，也可以是对象数组。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** 用例结构：id 必填，input/expected 为任意 JSON，tags 与 negative 有默认值。 */
export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown(),
  tags: z.array(z.string()).default([]),
  negative: z.boolean().default(false),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** 校验单条用例；失败时带上来源（文件#序号）方便定位。 */
export function parseEvalCase(raw: unknown, source = 'case'): EvalCase {
  const parsed = EvalCaseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${source}: invalid eval case: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * 加载目录下所有 .json 用例，按文件名排序保证顺序稳定，
 * 并检查 id 唯一，避免指标统计串用例。
 */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const absolute = path.resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch (error) {
    throw new Error(`cannot read eval cases from ${absolute}: ${(error as Error).message}`);
  }

  const cases: EvalCase[] = [];
  // 排序后再读，保证多次运行得到相同的用例顺序。
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const filePath = path.join(absolute, entry);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    const records = Array.isArray(raw) ? raw : [raw];
    for (const [index, record] of records.entries()) {
      cases.push(parseEvalCase(record, `${filePath}#${index}`));
    }
  }

  // id 重复会让 pass^k 与失败列表失真，直接报错。
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`duplicate eval case id: ${testCase.id}`);
    ids.add(testCase.id);
  }
  return cases;
}
