import type { Tracer } from '../trace/tracer.js';
import { argsDigest, type ToolFilter } from './chain.js';

export interface AuditOptions {
  tracer?: Tracer;
}

export function createAuditFilter(options: AuditOptions = {}): ToolFilter {
  return {
    name: 'audit',
    order: 50,
    async before(call, next) {
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
