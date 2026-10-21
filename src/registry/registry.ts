/**
 * 技能注册表：按作用域存储技能，负责依赖解析与闭包检查。
 * 解析策略是严格的：同优先级出现多个版本时直接报错，不做“最近者胜”。
 */
import semver from 'semver';
import type { SkillManifest } from '../manifest/schema.js';
import { satisfiesRange } from '../manifest/validate.js';
import { SCOPE_PRECEDENCE, scopeKey, type RegisteredSkill } from './scope.js';

/** 依赖缺失、版本歧义、冲突或环都会抛出该错误。 */
export class DependencyConflictError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'DependencyConflictError';
  }
}

/** 按名称与范围找不到任何注册项时抛出。 */
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
  /** 解析技能及其全部依赖，返回去重后的拓扑顺序。 */
  resolveClosure(name: string, range?: string): RegisteredSkill[];
  unregister(name: string, scope: RegisteredSkill['scope'], sessionId?: string): boolean;
}

/**
 * 创建注册表。
 * 严格解析：同一作用域出现多个匹配版本时直接报错，避免“装的是哪个版本”靠猜。
 */
export function createRegistry(initial: readonly RegisteredSkill[] = []): Registry {
  const entries = new Map<string, RegisteredSkill>();

  // 返回稳定排序后的快照，保证 list() 与依赖遍历结果可复现。
  function all(): RegisteredSkill[] {
    return [...entries.values()].sort((a, b) =>
      `${a.manifest.name}@${a.manifest.version}:${a.scope}:${a.sessionId ?? ''}`.localeCompare(
        `${b.manifest.name}@${b.manifest.version}:${b.scope}:${b.sessionId ?? ''}`,
      ),
    );
  }

  function register(skill: RegisteredSkill): void {
    // 先按作用域键检查重复注册：完全相同视为幂等，不同则冲突。
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

    // singleton 额外限制：同名技能只能存在一个版本。
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

  // 先筛出名称与版本范围都匹配的候选，再按作用域优先级选择。
  function candidates(name: string, range: string): RegisteredSkill[] {
    return all().filter(
      (entry) => entry.manifest.name === name && satisfiesRange(range, entry.manifest.version),
    );
  }

  function resolve(name: string, range = '*'): RegisteredSkill {
    const matches = candidates(name, range);
    if (matches.length === 0) throw new SkillNotFoundError(`${name}@${range}`);

    // 从高优先级作用域开始找；同作用域出现多个版本视为歧义。
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

    // 深度优先遍历依赖；visiting 用于检测环，resolved 用于去重。
    function visit(skill: RegisteredSkill): void {
      const key = `${skill.manifest.name}@${skill.manifest.version}`;
      if (resolved.has(key)) return;
      if (visiting.has(key)) {
        throw new DependencyConflictError(`dependency cycle involving ${key}`);
      }
      visiting.add(key);

      // 已注册技能与当前技能声明冲突时立即失败。
      for (const conflict of skill.manifest.conflicts) {
        const hit = all().find((entry) => entry.manifest.name === conflict);
        if (hit !== undefined) {
          throw new DependencyConflictError(
            `${skill.manifest.name} conflicts with registered skill ${conflict}@${hit.manifest.version}`,
          );
        }
      }

      // 逐个解析依赖并递归；解析失败时补充“谁依赖了它”。
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

/** 把解析后的清单包装成注册项；入口处统一校验 semver 版本。 */
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
