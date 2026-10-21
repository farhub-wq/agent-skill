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

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const exampleDir = path.join(repoRoot, 'examples', 'invoice-reconcile');

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
