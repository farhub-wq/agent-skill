import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  clock?: () => number;
}

export function createRateLimitFilter(options: RateLimitOptions = {}): ToolFilter {
  const limit = options.limit ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const clock = options.clock ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    name: 'rate-limit',
    order: 10,
    async before(call, next) {
      const now = clock();
      const key = `${call.caller.id}:${call.tool}`;
      const recent = (hits.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
      if (recent.length >= limit) {
        throw new FilterPolicyError('RATE_LIMITED', `rate limit exceeded for ${call.tool}`);
      }
      recent.push(now);
      hits.set(key, recent);
      return next();
    },
  };
}
