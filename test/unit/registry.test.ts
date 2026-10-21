/**
 * 注册表单元测试：幂等注册、同作用域冲突、singleton 唯一性、
 * 作用域优先级、歧义检测与依赖闭包。
 */
import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  DependencyConflictError,
  SkillNotFoundError,
  toRegisteredSkill,
} from '../../src/registry/registry.js';
import { registeredSkill, makeManifest } from '../helpers.js';

describe('registry registration', () => {
  it('treats an identical registration as a no-op', () => {
    const skill = registeredSkill({}, { dir: '/repo/demo', scope: 'repo' });
    const registry = createRegistry([skill]);
    registry.register(skill);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a conflicting registration in the same scope', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.0.0' }, { dir: '/repo/a', scope: 'repo' }),
    ]);
    expect(() =>
      registry.register(registeredSkill({ version: '2.0.0' }, { dir: '/repo/b', scope: 'repo' })),
    ).toThrow(DependencyConflictError);
  });

  it('rejects a duplicate singleton at a different version', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.0.0' }, { dir: '/singleton/a', scope: 'singleton' }),
    ]);
    expect(() =>
      registry.register(
        registeredSkill({ version: '1.1.0' }, { dir: '/singleton/b', scope: 'singleton' }),
      ),
    ).toThrow(/conflicting registration/);
  });

  it('rejects non-semver versions at registration', () => {
    expect(() => toRegisteredSkill(makeManifest({ version: '1.0' }), '/x', 'repo')).toThrow(
      /invalid skill version/,
    );
  });
});

describe('resolution', () => {
  it('honours scope precedence task > session > repo > singleton', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.0.0' }, { dir: '/s', scope: 'singleton' }),
      registeredSkill({ version: '1.1.0' }, { dir: '/r', scope: 'repo' }),
      registeredSkill({ version: '1.2.0' }, { dir: '/t', scope: 'task' }),
    ]);
    expect(registry.resolve('demo-skill').manifest.version).toBe('1.2.0');

    registry.unregister('demo-skill', 'task');
    expect(registry.resolve('demo-skill').manifest.version).toBe('1.1.0');

    registry.unregister('demo-skill', 'repo');
    expect(registry.resolve('demo-skill').manifest.version).toBe('1.0.0');
  });

  it('filters by semver range', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.4.0' }, { dir: '/r1', scope: 'repo' }),
      registeredSkill({ version: '2.0.0' }, { dir: '/r2', scope: 'singleton' }),
    ]);
    expect(registry.resolve('demo-skill', '^1.0.0').manifest.version).toBe('1.4.0');
    expect(registry.resolve('demo-skill', '>=2').manifest.version).toBe('2.0.0');
  });

  it('fails loudly when one scope holds two versions', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.0.0' }, { dir: '/a', scope: 'session', sessionId: 'a' }),
      registeredSkill({ version: '1.1.0' }, { dir: '/b', scope: 'session', sessionId: 'b' }),
    ]);
    expect(() => registry.resolve('demo-skill')).toThrow(/ambiguous demo-skill/);
  });

  it('throws SkillNotFoundError for unknown names and ranges', () => {
    const registry = createRegistry();
    expect(() => registry.resolve('missing')).toThrow(SkillNotFoundError);
    expect(() => registry.resolve('demo-skill', '^9')).toThrow(SkillNotFoundError);
  });
});

describe('dependency closure', () => {
  it('returns dependencies before dependents', () => {
    const registry = createRegistry([
      registeredSkill(
        { name: 'alpha', requires: { beta: '^1.0.0' } },
        { dir: '/alpha', scope: 'repo' },
      ),
      registeredSkill({ name: 'beta', version: '1.2.0' }, { dir: '/beta', scope: 'repo' }),
    ]);
    const closure = registry.resolveClosure('alpha');
    expect(closure.map((skill) => skill.manifest.name)).toEqual(['beta', 'alpha']);
  });

  it('rejects unresolved dependencies', () => {
    const registry = createRegistry([
      registeredSkill(
        { name: 'alpha', requires: { beta: '^1.0.0' } },
        { dir: '/alpha', scope: 'repo' },
      ),
    ]);
    expect(() => registry.resolveClosure('alpha')).toThrow(/unresolved dependency beta/);
  });

  it('rejects registered conflicts', () => {
    const registry = createRegistry([
      registeredSkill({ name: 'alpha', conflicts: ['beta'] }, { dir: '/alpha', scope: 'repo' }),
      registeredSkill({ name: 'beta' }, { dir: '/beta', scope: 'repo' }),
    ]);
    expect(() => registry.resolveClosure('alpha')).toThrow(/conflicts with registered skill beta/);
  });

  it('detects dependency cycles', () => {
    const registry = createRegistry([
      registeredSkill(
        { name: 'alpha', requires: { beta: '^1.0.0' } },
        { dir: '/alpha', scope: 'repo' },
      ),
      registeredSkill(
        { name: 'beta', requires: { alpha: '^1.0.0' } },
        { dir: '/beta', scope: 'repo' },
      ),
    ]);
    expect(() => registry.resolveClosure('alpha')).toThrow(/dependency cycle/);
  });
});

describe('unregistration', () => {
  it('removes only the matching scope and session', () => {
    const registry = createRegistry([
      registeredSkill({ version: '1.0.0' }, { dir: '/s1', scope: 'session', sessionId: 'one' }),
      registeredSkill({ version: '1.1.0' }, { dir: '/s2', scope: 'session', sessionId: 'two' }),
    ]);
    expect(registry.unregister('demo-skill', 'session', 'one')).toBe(true);
    expect(registry.unregister('demo-skill', 'session', 'one')).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });
});
