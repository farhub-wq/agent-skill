/**
 * 注册作用域：同一个技能可以在不同作用域各注册一份。
 * 解析时按优先级选择，不在版本之间静默回退。
 */
import type { SkillManifest } from '../manifest/schema.js';

/** 全部合法作用域：singleton 全局唯一，session 按会话，repo 按仓库，task 按任务。 */
export const SCOPES = ['singleton', 'session', 'task', 'repo'] as const;
export type Scope = (typeof SCOPES)[number];

/** 解析优先级从高到低：task > session > repo > singleton。 */
export const SCOPE_PRECEDENCE: readonly Scope[] = ['task', 'session', 'repo', 'singleton'];

export interface RegisteredSkill {
  /** 已解析并校验过的运行时清单。 */
  manifest: SkillManifest;
  /** 技能目录的绝对路径。 */
  dir: string;
  /** 注册作用域。 */
  scope: Scope;
  /** session 作用域必填，用于隔离不同会话。 */
  sessionId?: string;
}

/** 生成注册表唯一键；未提供 sessionId 时用 `-` 占位。 */
export function scopeKey(skill: RegisteredSkill): string {
  return `${skill.scope}:${skill.sessionId ?? '-'}:${skill.manifest.name}`;
}
