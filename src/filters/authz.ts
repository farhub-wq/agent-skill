/**
 * 身份过滤器：要求调用方有非空身份，并按工具检查角色。
 * 这是过滤链的第二道（order 20），在能力检查之前拒绝匿名调用。
 */
import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface AuthzOptions {
  /** 工具名到所需角色的映射；未列出的工具不额外限制。 */
  requiredRoles?: Record<string, readonly string[]>;
}

export function createAuthzFilter(options: AuthzOptions = {}): ToolFilter {
  const requiredRoles = options.requiredRoles ?? {};

  return {
    name: 'authz',
    order: 20,
    async before(call, next) {
      // 空身份无法审计，也无法区分租户，直接拒绝。
      if (call.caller.id.trim().length === 0) {
        throw new FilterPolicyError('UNAUTHORIZED', 'caller identity is required');
      }
      // 角色要求是“任一命中即可”，不要求同时具备全部角色。
      const required = requiredRoles[call.tool] ?? [];
      if (required.length > 0 && !required.some((role) => call.caller.roles.includes(role))) {
        throw new FilterPolicyError(
          'UNAUTHORIZED',
          `caller ${call.caller.id} lacks a required role for ${call.tool}`,
        );
      }
      return next();
    },
  };
}
