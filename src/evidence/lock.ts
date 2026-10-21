import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceCard } from '../eval/evidence.js';

export interface EvidenceLock {
  algorithm: 'sha256';
  digest: string;
  file: 'evidence.json';
  skill: string;
  version: string;
  generated_at: string;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

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

export async function verifyEvidenceLock(evidencePath: string, lockPath: string): Promise<boolean> {
  const card = JSON.parse(await readFile(evidencePath, 'utf8')) as EvidenceCard;
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as EvidenceLock;
  return lock.algorithm === 'sha256' && lock.digest === sha256Hex(stableStringify(card));
}
