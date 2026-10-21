import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TraceEvent, TraceSink } from './events.js';

export function createJsonlLedger(filePath: string): TraceSink {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  return {
    append(event: TraceEvent): void {
      appendFileSync(absolute, `${JSON.stringify(event)}\n`, 'utf8');
    },
  };
}

export function readLedger(filePath: string): TraceEvent[] {
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}
