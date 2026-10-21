import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown(),
  tags: z.array(z.string()).default([]),
  negative: z.boolean().default(false),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

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

export async function loadCases(dir: string): Promise<EvalCase[]> {
  const absolute = path.resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch (error) {
    throw new Error(`cannot read eval cases from ${absolute}: ${(error as Error).message}`);
  }

  const cases: EvalCase[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const filePath = path.join(absolute, entry);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    const records = Array.isArray(raw) ? raw : [raw];
    for (const [index, record] of records.entries()) {
      cases.push(parseEvalCase(record, `${filePath}#${index}`));
    }
  }

  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`duplicate eval case id: ${testCase.id}`);
    ids.add(testCase.id);
  }
  return cases;
}
