/**
 * 限流过滤器：按调用方与工具维度做滑动窗口计数。
 * 这是过滤链的第一道（order 10），避免后续昂贵检查被高频调用拖垮。
 */
import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface RateLimitOptions {
  /** 窗口内允许的最大调用次数，默认 60。 */
  limit?: number;
  /** 窗口长度（毫秒），默认 60 秒。 */
  windowMs?: number;
  /** 可注入时钟，测试用固定时间验证窗口行为。 */
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
      // 以“调用方 + 工具”为键，避免一个高频工具挤占其他工具额度。
      const key = `${call.caller.id}:${call.tool}`;
      // 先剔除窗口外的旧记录，再判断是否超限。
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
