/**
 * JSONL 账本：一行一个事件，追加写入。
 * 选择 JSONL 而不是单个 JSON 数组，是为了写入失败时只损失最后一行。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TraceEvent, TraceSink } from './events.js';

/** 创建账本 sink；父目录不存在时自动补建。 */
export function createJsonlLedger(filePath: string): TraceSink {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  return {
    append(event: TraceEvent): void {
      appendFileSync(absolute, `${JSON.stringify(event)}\n`, 'utf8');
    },
  };
}

/**
 * 读取账本。空行会被忽略；当前实现遇到损坏行会直接抛错，
 * 由调用方决定是丢弃整份账本还是人工修复。
 */
export function readLedger(filePath: string): TraceEvent[] {
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}
