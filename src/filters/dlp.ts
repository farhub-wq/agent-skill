import type { DataClass } from '../manifest/schema.js';
import { FilterPolicyError, type ToolFilter } from './chain.js';

export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
];

export const PII_PATTERNS: readonly RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

export interface DlpOptions {
  allowedData: readonly DataClass[];
}

function detect(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Messages never contain the matched value: a DLP event must not become the
 * leak it is meant to prevent.
 */
export function createDlpFilter(options: DlpOptions): ToolFilter {
  return {
    name: 'dlp',
    order: 40,
    async before(call, next) {
      const text = JSON.stringify(call.args);
      if (detect(SECRET_PATTERNS, text) && !options.allowedData.includes('secrets')) {
        throw new FilterPolicyError('DLP_SECRET_BLOCKED', 'arguments contain a secret and secrets are not allowed');
      }
      if (detect(PII_PATTERNS, text) && !options.allowedData.includes('pii')) {
        throw new FilterPolicyError('DLP_PII_BLOCKED', 'arguments contain PII and pii is not allowed');
      }
      return next();
    },
  };
}
