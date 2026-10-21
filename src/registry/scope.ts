import type { SkillManifest } from '../manifest/schema.js';

export const SCOPES = ['singleton', 'session', 'task', 'repo'] as const;
export type Scope = (typeof SCOPES)[number];

/** Highest precedence first. Resolution never falls back across versions silently. */
export const SCOPE_PRECEDENCE: readonly Scope[] = ['task', 'session', 'repo', 'singleton'];

export interface RegisteredSkill {
  manifest: SkillManifest;
  dir: string;
  scope: Scope;
  sessionId?: string;
}

export function scopeKey(skill: RegisteredSkill): string {
  return `${skill.scope}:${skill.sessionId ?? '-'}:${skill.manifest.name}`;
}
