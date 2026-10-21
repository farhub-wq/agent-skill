/**
 * 证据卡：把评测指标、门禁结果与技能目录完整性固定为可校验的 JSON。
 * data_source 固定为 synthetic，避免把本地模拟数据包装成真实评测。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TrustTier } from '../admission/tier.js';
import type { EvalMetrics } from './metrics.js';

/** 证据卡字段；下划线命名与对外 JSON 约定一致。 */
export interface EvidenceCard {
  skill: string;
  version: string;
  integrity: string;
  data_source: 'synthetic';
  n: number;
  'pass@1': number;
  pass_at_1_ci95: [number, number];
  'pass^k': number;
  cost_per_success: number;
  p95_latency: number;
  escalation_rate: number;
  known_failures: string[];
  gates: Record<'G1' | 'G2' | 'G3' | 'G4', boolean | 'skipped'>;
  trust_tier: TrustTier;
  model_matrix: string[];
  harness_version: string;
  generated_at: string;
}

/** 计算完整性时跳过的目录，避免把缓存和证据自身算进去。 */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'evidence', '.agent-skill']);

/** 递归列出目录内所有文件（相对路径），跳过 SKIP_DIRECTORIES。 */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(dir, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** 目录完整性哈希：覆盖所有随包文件，不只是 SKILL.md。 */
export async function hashSkillDir(dir: string): Promise<string> {
  const root = path.resolve(dir);
  const files = (await walkFiles(root)).sort();
  // 先按路径排序再逐个哈希，保证同一目录在任何机器上得到相同结果。
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const relative of files) {
    const content = await readFile(path.join(root, relative));
    entries.push({
      path: relative,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

/** 生成证据卡所需的输入。 */
export interface EvidenceInput {
  skill: string;
  version: string;
  dir: string;
  trustTier: TrustTier;
  metrics: EvalMetrics;
  gates: Record<'G1' | 'G2' | 'G3' | 'G4', boolean | 'skipped'>;
  generatedAt: Date;
  modelMatrix?: readonly string[];
  harnessVersion: string;
}

/** 组装证据卡：指标映射到对外字段名，并固定数组排序。 */
export async function buildEvidenceCard(input: EvidenceInput): Promise<EvidenceCard> {
  return {
    skill: input.skill,
    version: input.version,
    integrity: await hashSkillDir(input.dir),
    data_source: 'synthetic',
    n: input.metrics.n,
    'pass@1': input.metrics['pass@1'],
    pass_at_1_ci95: input.metrics.passAt1Ci95,
    'pass^k': input.metrics['pass^k'],
    cost_per_success: input.metrics.costPerSuccess,
    p95_latency: input.metrics.p95LatencyMs,
    escalation_rate: input.metrics.escalationRate,
    known_failures: [...input.metrics.knownFailures].sort(),
    gates: input.gates,
    trust_tier: input.trustTier,
    model_matrix: [...(input.modelMatrix ?? ['synthetic:mock'])].sort(),
    harness_version: input.harnessVersion,
    generated_at: input.generatedAt.toISOString(),
  };
}
