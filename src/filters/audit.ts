/**
 * 审计过滤器：在调用前后各写一条 audit.record，并给结果附加参数摘要。
 * 这是过滤链的最后一道（order 50），确保前面所有检查都有审计痕迹。
 */
import type { Tracer } from '../trace/tracer.js';
import { argsDigest, type ToolFilter } from './chain.js';

export interface AuditOptions {
  /** 未注入时只返回结果摘要，不写 trace。 */
  tracer?: Tracer;
}

export function createAuditFilter(options: AuditOptions = {}): ToolFilter {
  return {
    name: 'audit',
    order: 50,
    async before(call, next) {
      // 只记录参数摘要，不记录原始参数，避免审计日志变成敏感数据副本。
      options.tracer?.emit('audit.record', {
        phase: 'before',
        callId: call.id,
        tool: call.tool,
        capability: call.capability,
        argsDigest: argsDigest(call.args),
      });
      return next();
    },
    async after(call, result) {
      // 回卷阶段记录结果状态，供后续统计成功率与失败码。
      options.tracer?.emit('audit.record', {
        phase: 'after',
        callId: call.id,
        tool: call.tool,
        outcome: result.ok ? 'ok' : 'error',
      });
      return {
        ...result,
        meta: {
          ...result.meta,
          audit: { callId: call.id, argsDigest: argsDigest(call.args), outcome: result.ok ? 'ok' : 'error' },
        },
      };
    },
  };
}
