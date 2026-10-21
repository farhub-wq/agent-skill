/**
 * 证据锁：为 evidence.json 生成 sha256 摘要，验证时重算比对，
 * 用于发现证据被替换或篡改。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceCard } from '../eval/evidence.js';

/** evidence.lock 的结构。 */
export interface EvidenceLock {
  algorithm: 'sha256';
  digest: string;
  file: 'evidence.json';
  skill: string;
  version: string;
  generated_at: string;
}

/**
 * 稳定序列化：对象键排序、数组保序，保证同一内容总是得到同一字符串，
 * 这是摘要可复现的前提。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/** 计算字符串的 sha256 十六进制摘要。 */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 写入 evidence.json 与 evidence.lock。
 * 注意：digest 基于稳定序列化计算，而文件本身是带缩进的美化 JSON，
 * 因此验证时必须重新解析后计算，不能直接哈希文件字节。
 */
export async function writeEvidenceFiles(
  dir: string,
  card: EvidenceCard,
): Promise<{ evidencePath: string; lockPath: string; digest: string }> {
  const target = path.resolve(dir);
  await mkdir(target, { recursive: true });
  const evidencePath = path.join(target, 'evidence.json');
  const lockPath = path.join(target, 'evidence.lock');
  const body = `${JSON.stringify(card, null, 2)}\n`;
  const digest = sha256Hex(stableStringify(card));
  const lock: EvidenceLock = {
    algorithm: 'sha256',
    digest,
    file: 'evidence.json',
    skill: card.skill,
    version: card.version,
    generated_at: card.generated_at,
  };
  await writeFile(evidencePath, body, 'utf8');
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return { evidencePath, lockPath, digest };
}

/** 重新计算证据卡摘要并与 lock 比对；算法不是 sha256 也判失败。 */
export async function verifyEvidenceLock(evidencePath: string, lockPath: string): Promise<boolean> {
  const card = JSON.parse(await readFile(evidencePath, 'utf8')) as EvidenceCard;
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as EvidenceLock;
  return lock.algorithm === 'sha256' && lock.digest === sha256Hex(stableStringify(card));
}
