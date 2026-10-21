/**
 * 默认过滤链装配：把五个过滤器按固定顺序组合起来。
 * 顺序是契约的一部分，测试会做快照；不要在调用方随意调换。
 */
import type { Permissions } from '../manifest/schema.js';
import type { Tracer } from '../trace/tracer.js';
import { createAuditFilter } from './audit.js';
import { createAuthzFilter } from './authz.js';
import type { ToolFilter } from './chain.js';
import { createCapabilityFilter } from './capability.js';
import { createDlpFilter } from './dlp.js';
import { createRateLimitFilter } from './rate-limit.js';

export interface DefaultFilterOptions {
  /** 技能声明的能力列表。 */
  capabilities: readonly string[];
  /** 与能力配套的具体权限。 */
  permissions: Permissions;
  /** 传入后审计过滤器才能写 trace。 */
  tracer?: Tracer;
  /** 工具级角色要求。 */
  requiredRoles?: Record<string, readonly string[]>;
  /** 限流参数，测试可注入短窗口与固定时钟。 */
  rateLimit?: { limit?: number; windowMs?: number; clock?: () => number };
}

/** 固定顺序：限流 -> 身份 -> 能力 -> DLP -> 审计 -> 执行。 */
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
