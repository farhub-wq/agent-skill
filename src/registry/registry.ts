import semver from 'semver';
import type { SkillManifest } from '../manifest/schema.js';
import { satisfiesRange } from '../manifest/validate.js';
import { SCOPE_PRECEDENCE, scopeKey, type RegisteredSkill } from './scope.js';

export class DependencyConflictError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'DependencyConflictError';
  }
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill not found: ${name}`);
    this.name = 'SkillNotFoundError';
  }
}

export interface Registry {
  register(skill: RegisteredSkill): void;
  list(): RegisteredSkill[];
  resolve(name: string, range?: string): RegisteredSkill;
  resolveClosure(name: string, range?: string): RegisteredSkill[];
  unregister(name: string, scope: RegisteredSkill['scope'], sessionId?: string): boolean;
}

/**
 * Strict resolution: no nearest-wins arbitration. When two versions compete at
 * the same precedence, registration or resolution fails loudly.
 */
export function createRegistry(initial: readonly RegisteredSkill[] = []): Registry {
  const entries = new Map<string, RegisteredSkill>();

  function all(): RegisteredSkill[] {
    return [...entries.values()].sort((a, b) =>
      `${a.manifest.name}@${a.manifest.version}:${a.scope}:${a.sessionId ?? ''}`.localeCompare(
        `${b.manifest.name}@${b.manifest.version}:${b.scope}:${b.sessionId ?? ''}`,
      ),
    );
  }

  function register(skill: RegisteredSkill): void {
    const key = scopeKey(skill);
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (existing.manifest.version !== skill.manifest.version || existing.dir !== skill.dir) {
        throw new DependencyConflictError(
          `conflicting registration for ${skill.manifest.name} in scope ${skill.scope}`,
          [`${existing.manifest.version} @ ${existing.dir}`, `${skill.manifest.version} @ ${skill.dir}`],
        );
      }
      return;
    }

    if (skill.scope === 'singleton') {
      const other = all().find(
        (entry) => entry.scope === 'singleton' && entry.manifest.name === skill.manifest.name,
      );
      if (other !== undefined && other.manifest.version !== skill.manifest.version) {
        throw new DependencyConflictError(
          `singleton skill ${skill.manifest.name} already registered at ${other.manifest.version}`,
          [`requested ${skill.manifest.version}`, `registered ${other.manifest.version}`],
        );
      }
    }

    entries.set(key, skill);
  }

  function candidates(name: string, range: string): RegisteredSkill[] {
    return all().filter(
      (entry) => entry.manifest.name === name && satisfiesRange(range, entry.manifest.version),
    );
  }

  function resolve(name: string, range = '*'): RegisteredSkill {
    const matches = candidates(name, range);
    if (matches.length === 0) throw new SkillNotFoundError(`${name}@${range}`);

    for (const scope of SCOPE_PRECEDENCE) {
      const inScope = matches.filter((entry) => entry.scope === scope);
      if (inScope.length === 0) continue;
      const versions = [...new Set(inScope.map((entry) => entry.manifest.version))];
      if (versions.length > 1) {
        throw new DependencyConflictError(
          `ambiguous ${name} in scope ${scope}: ${versions.join(', ')}`,
          inScope.map((entry) => `${entry.manifest.version} @ ${entry.dir}`),
        );
      }
      return inScope[0] as RegisteredSkill;
    }
    return matches[0] as RegisteredSkill;
  }

  function resolveClosure(name: string, range = '*'): RegisteredSkill[] {
    const resolved = new Map<string, RegisteredSkill>();
    const visiting = new Set<string>();

    function visit(skill: RegisteredSkill): void {
      const key = `${skill.manifest.name}@${skill.manifest.version}`;
      if (resolved.has(key)) return;
      if (visiting.has(key)) {
        throw new DependencyConflictError(`dependency cycle involving ${key}`);
      }
      visiting.add(key);

      for (const conflict of skill.manifest.conflicts) {
        const hit = all().find((entry) => entry.manifest.name === conflict);
        if (hit !== undefined) {
          throw new DependencyConflictError(
            `${skill.manifest.name} conflicts with registered skill ${conflict}@${hit.manifest.version}`,
          );
        }
      }

      for (const [dependency, dependencyRange] of Object.entries(skill.manifest.requires)) {
        let match: RegisteredSkill;
        try {
          match = resolve(dependency, dependencyRange);
        } catch (error) {
          throw new DependencyConflictError(
            `unresolved dependency ${dependency}@${dependencyRange} required by ${skill.manifest.name}`,
            [(error as Error).message],
          );
        }
        visit(match);
      }

      visiting.delete(key);
      resolved.set(key, skill);
    }

    visit(resolve(name, range));
    return [...resolved.values()];
  }

  function unregister(
    name: string,
    scope: RegisteredSkill['scope'],
    sessionId?: string,
  ): boolean {
    const key = `${scope}:${sessionId ?? '-'}:${name}`;
    return entries.delete(key);
  }

  for (const skill of initial) register(skill);

  return { register, list: all, resolve, resolveClosure, unregister };
}

export function toRegisteredSkill(
  manifest: SkillManifest,
  dir: string,
  scope: RegisteredSkill['scope'],
  sessionId?: string,
): RegisteredSkill {
  if (!semver.valid(manifest.version)) {
    throw new DependencyConflictError(`invalid skill version: ${manifest.version}`);
  }
  return { manifest, dir, scope, ...(sessionId === undefined ? {} : { sessionId }) };
}
