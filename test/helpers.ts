/**
 * 测试共享工具：仓库路径、清单构造器、注册技能与工具调用默认值。
 * 所有单元测试都通过这里构造数据，避免各自重复拼装。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCall } from '../src/filters/chain.js';
import {
  SkillManifestSchema,
  type Permissions,
  type SkillManifest,
  type TrustLevel,
} from '../src/manifest/schema.js';
import { toRegisteredSkill } from '../src/registry/registry.js';
import type { RegisteredSkill, Scope } from '../src/registry/scope.js';

/** 仓库根目录（由本文件位置向上推一层）。 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 示例技能目录，集成测试与 CLI 测试共用。 */
export const exampleDir = path.join(repoRoot, 'examples', 'invoice-reconcile');

/** 拼接 test/fixtures 下的夹具路径。 */
export function fixtureDir(...parts: string[]): string {
  return path.join(repoRoot, 'test', 'fixtures', ...parts);
}

export interface ManifestOverrides {
  name?: string;
  version?: string;
  capabilities?: string[];
  requires?: Record<string, string>;
  conflicts?: string[];
  trust?: TrustLevel;
  eval?: string;
  permissions?: {
    fs?: string[];
    net?: string[];
    exec?: string[];
    data?: Permissions['data'];
    irreversible?: string[];
  };
}

/** 构造合法清单，未覆盖字段使用可用的默认值。 */
export function makeManifest(overrides: ManifestOverrides = {}): SkillManifest {
  const permissions = overrides.permissions;
  return SkillManifestSchema.parse({
    name: overrides.name ?? 'demo-skill',
    version: overrides.version ?? '1.0.0',
    capabilities: overrides.capabilities ?? ['fs.read'],
    requires: overrides.requires ?? {},
    conflicts: overrides.conflicts ?? [],
    trust: overrides.trust ?? 'community',
    ...(overrides.eval === undefined ? {} : { eval: overrides.eval }),
    ...(permissions === undefined
      ? {}
      : {
          permissions: {
            fs: permissions.fs ?? [],
            net: permissions.net ?? [],
            exec: permissions.exec ?? [],
            data: permissions.data ?? [],
            irreversible: permissions.irreversible ?? [],
          },
        }),
  });
}

/** 在 makeManifest 基础上封装为已注册技能，默认 task 作用域。 */
export function registeredSkill(
  overrides: ManifestOverrides = {},
  options: { dir?: string; scope?: Scope; sessionId?: string } = {},
): RegisteredSkill {
  const manifest = makeManifest(overrides);
  return toRegisteredSkill(
    manifest,
    options.dir ?? repoRoot,
    options.scope ?? 'task',
    options.sessionId,
  );
}

/** 构造只读工具调用，测试中按需覆盖字段。 */
export function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    tool: 'Read',
    capability: 'fs.read',
    args: {},
    sideEffect: 'readonly',
    caller: { id: 'caller-1', roles: ['agent'] },
    skill: 'demo-skill',
    runId: 'run-1',
    ...overrides,
  };
}
