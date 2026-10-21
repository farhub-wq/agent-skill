/**
 * 能力过滤器：工具调用必须落在技能声明的 capability 内，
 * 且对应权限类别必须有非空声明（网络白名单、可执行命令、文件根目录）。
 * 这是过滤链的第三道（order 30）。
 */
import { hasCapability } from '../admission/skill-md.js';
import type { Permissions } from '../manifest/schema.js';
import { FilterPolicyError, type ToolFilter } from './chain.js';

export interface CapabilityOptions {
  /** `skill.yaml` 中声明的能力列表。 */
  capabilities: readonly string[];
  /** 与能力配套的具体权限声明。 */
  permissions: Permissions;
}

export function createCapabilityFilter(options: CapabilityOptions): ToolFilter {
  return {
    name: 'capability',
    order: 30,
    async before(call, next) {
      // 第一层：能力本身必须被声明，支持 `fs.*` 这类通配写法。
      if (!hasCapability(options.capabilities, call.capability)) {
        throw new FilterPolicyError(
          'CAPABILITY_DENIED',
          `skill does not declare capability ${call.capability}`,
        );
      }

      // 第二层：只有能力声明还不够，具体权限清单也必须非空。
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
