import { hasCapability } from '../admission/skill-md.js';
import type { Permissions } from '../manifest/schema.js';
import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface CapabilityOptions {
  capabilities: readonly string[];
  permissions: Permissions;
}

export function createCapabilityFilter(options: CapabilityOptions): ToolFilter {
  return {
    name: 'capability',
    order: 30,
    async before(call, next) {
      if (!hasCapability(options.capabilities, call.capability)) {
        throw new FilterPolicyError(
          'CAPABILITY_DENIED',
          `skill does not declare capability ${call.capability}`,
        );
      }

      if (call.capability.startsWith('net') && options.permissions.net.length === 0) {
        throw new FilterPolicyError('NETWORK_DENIED', 'no network allowlist declared');
      }
      if (call.capability.startsWith('exec') && options.permissions.exec.length === 0) {
        throw new FilterPolicyError('EXEC_NOT_DECLARED', 'no executable declared');
      }
      if (call.capability.startsWith('fs.') && options.permissions.fs.length === 0) {
        throw new FilterPolicyError('PATH_DENIED', 'no filesystem root declared');
      }

      return next();
    },
  };
}
