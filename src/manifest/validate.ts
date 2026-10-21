import semver from 'semver';
import type { SkillManifest } from './schema.js';

export interface ManifestIssue {
  field: string;
  message: string;
}

export class ManifestValidationError extends Error {
  constructor(readonly issues: ManifestIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'ManifestValidationError';
  }
}

export function validateManifest(manifest: SkillManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];

  if (!semver.valid(manifest.version)) {
    issues.push({ field: 'version', message: `not a semver version: ${manifest.version}` });
  }

  for (const [name, range] of Object.entries(manifest.requires)) {
    if (semver.validRange(range) === null) {
      issues.push({ field: `requires.${name}`, message: `invalid semver range: ${range}` });
    }
  }

  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    issues.push({ field: 'capabilities', message: 'duplicate capability entries' });
  }

  if (manifest.conflicts.includes(manifest.name)) {
    issues.push({ field: 'conflicts', message: 'skill cannot conflict with itself' });
  }

  for (const entry of manifest.permissions.fs) {
    if (entry.includes('\0')) {
      issues.push({ field: 'permissions.fs', message: 'NUL byte in path entry' });
    }
  }

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

export function satisfiesRange(range: string, version: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true });
}
