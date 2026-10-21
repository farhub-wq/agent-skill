/**
 * 清单语义校验：schema 只管类型，这里补充版本范围、重复项、路径字节等规则。
 * 返回问题列表而不是直接抛错，便于 `inspect` 一次展示全部问题。
 */
import semver from 'semver';
import type { SkillManifest } from './schema.js';

export interface ManifestIssue {
  field: string;
  message: string;
}

/** 当调用方要求“有错即抛”时使用，携带完整问题列表。 */
export class ManifestValidationError extends Error {
  constructor(readonly issues: ManifestIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'ManifestValidationError';
  }
}

/**
 * 校验清单的语义约束。
 * 核心步骤：版本合法性 -> 依赖范围 -> 能力去重 -> 自冲突 -> 路径字节 -> 空命令。
 */
export function validateManifest(manifest: SkillManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];

  // 版本必须是完整 semver，范围写法留给 requires 检查。
  if (!semver.valid(manifest.version)) {
    issues.push({ field: 'version', message: `not a semver version: ${manifest.version}` });
  }

  // 依赖版本必须是合法 semver 范围，例如 `^1.2.0`。
  for (const [name, range] of Object.entries(manifest.requires)) {
    if (semver.validRange(range) === null) {
      issues.push({ field: `requires.${name}`, message: `invalid semver range: ${range}` });
    }
  }

  // 能力声明重复会让权限推断出现歧义，直接判为问题。
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    issues.push({ field: 'capabilities', message: 'duplicate capability entries' });
  }

  // 技能不能与自己冲突，否则依赖闭包永远无法满足。
  if (manifest.conflicts.includes(manifest.name)) {
    issues.push({ field: 'conflicts', message: 'skill cannot conflict with itself' });
  }

  // NUL 字节会截断底层路径调用，必须在进入文件系统前拒绝。
  for (const entry of manifest.permissions.fs) {
    if (entry.includes('\0')) {
      issues.push({ field: 'permissions.fs', message: 'NUL byte in path entry' });
    }
  }

  // 空命令无法执行，也无法参与准入核对。
  for (const command of manifest.permissions.exec) {
    if (command.trim().length === 0) {
      issues.push({ field: 'permissions.exec', message: 'empty exec entry' });
    }
  }

  return issues;
}

export function assertValidManifest(manifest: SkillManifest): void {
  const issues = validateManifest(manifest);
  if (issues.length > 0) throw new ManifestValidationError(issues);
}

/** 判断版本是否满足范围；依赖解析时允许预发布版本参与。 */
export function satisfiesRange(range: string, version: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true });
}
