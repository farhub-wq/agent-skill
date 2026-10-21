import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface AuthzOptions {
  requiredRoles?: Record<string, readonly string[]>;
}

export function createAuthzFilter(options: AuthzOptions = {}): ToolFilter {
  const requiredRoles = options.requiredRoles ?? {};

  return {
    name: 'authz',
    order: 20,
    async before(call, next) {
      if (call.caller.id.trim().length === 0) {
        throw new FilterPolicyError('UNAUTHORIZED', 'caller identity is required');
      }
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
