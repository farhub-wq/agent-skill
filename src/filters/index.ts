import type { Permissions } from '../manifest/schema.js';
import type { Tracer } from '../trace/tracer.js';
import { createAuditFilter } from './audit.js';
import { createAuthzFilter } from './authz.js';
import type { ToolFilter } from './chain.js';
import { createCapabilityFilter } from './capability.js';
import { createDlpFilter } from './dlp.js';
import { createRateLimitFilter } from './rate-limit.js';

export interface DefaultFilterOptions {
  capabilities: readonly string[];
  permissions: Permissions;
  tracer?: Tracer;
  requiredRoles?: Record<string, readonly string[]>;
  rateLimit?: { limit?: number; windowMs?: number; clock?: () => number };
}

/** Fixed order: rate limit -> authz -> capability -> DLP -> audit -> execute. */
export function createDefaultFilters(options: DefaultFilterOptions): ToolFilter[] {
  return [
    createRateLimitFilter(options.rateLimit ?? {}),
    createAuthzFilter({ requiredRoles: options.requiredRoles ?? {} }),
    createCapabilityFilter({
      capabilities: options.capabilities,
      permissions: options.permissions,
    }),
    createDlpFilter({ allowedData: options.permissions.data }),
    createAuditFilter(options.tracer === undefined ? {} : { tracer: options.tracer }),
  ];
}

export { createAuditFilter } from './audit.js';
export { createAuthzFilter } from './authz.js';
export { createCapabilityFilter } from './capability.js';
export {
  createFilterChain,
  FilterPolicyError,
  type FilterChain,
  type SideEffect,
  type ToolCall,
  type ToolFilter,
  type ToolResult,
} from './chain.js';
export { createDlpFilter } from './dlp.js';
export { createRateLimitFilter } from './rate-limit.js';
