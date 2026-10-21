import path from 'node:path';
import type { SkillSource } from '../manifest/parse.js';
import { finding, type Advisory, type Finding } from './findings.js';
import { escapesSkillDir } from './g1-static.js';
import { permissionCeiling, tierForTrust } from './tier.js';

export interface G4Result {
  findings: Finding[];
  advisories: Advisory[];
}

/**
 * G4 reconciles declared permissions with the trust-tier ceiling. The ceiling
 * is not advisory: T1/T2 can never obtain script execution at runtime.
 */
export function runG4(source: SkillSource): G4Result {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const manifest = source.manifest;
  const manifestPath = `${source.dir}/skill.yaml`;
  const tier = tierForTrust(manifest.trust);
  const ceiling = permissionCeiling(tier);

  if (manifest.permissions.exec.length > 0 && !ceiling.exec) {
    findings.push(
      finding('undeclared-tool', `trust ${manifest.trust} (${tier}) cannot declare script execution`, {
        path: manifestPath,
      }),
    );
  }

  if (manifest.permissions.net.length > 0 && !ceiling.net) {
    findings.push(
      finding('network-egress', `trust ${manifest.trust} (${tier}) cannot declare network access`, {
        path: manifestPath,
      }),
    );
  }

  if (manifest.permissions.data.includes('secrets') && !ceiling.data.includes('secrets')) {
    findings.push(
      finding('undeclared-tool', `trust ${manifest.trust} (${tier}) cannot access secrets`, {
        path: manifestPath,
      }),
    );
  }

  for (const entry of manifest.permissions.fs) {
    if (escapesSkillDir(entry)) {
      findings.push(
        finding('path-escape', `filesystem permission resolves outside the skill directory: ${entry}`, {
          path: manifestPath,
          evidence: entry,
        }),
      );
      continue;
    }
    const resolved = path.resolve(source.dir, entry);
    if (resolved !== source.dir && !resolved.startsWith(`${source.dir}${path.sep}`)) {
      findings.push(
        finding('path-escape', `filesystem permission resolves outside the skill directory: ${entry}`, {
          path: manifestPath,
          evidence: entry,
        }),
      );
    }
  }

  for (const command of manifest.permissions.exec) {
    const script = command
      .split(/\s+/)
      .slice(1)
      .find((token) => token.startsWith('scripts/') || token.startsWith('./scripts/'));
    if (script === undefined) {
      advisories.push({
        id: 'g4-unconstrained-exec',
        message: `exec entry does not reference a shipped script: ${command}`,
        path: manifestPath,
      });
      continue;
    }
    const normalized = script.replace(/^\.\//, '');
    if (!source.scripts.includes(normalized)) {
      findings.push(
        finding('unlisted-script', `exec entry references a missing script: ${normalized}`, {
          path: manifestPath,
          evidence: command,
        }),
      );
    }
  }

  for (const entry of manifest.permissions.irreversible) {
    const declared = manifest.permissions.exec.some((command) => command.includes(entry));
    if (!declared) {
      advisories.push({
        id: 'g4-irreversible-unmatched',
        message: `irreversible permission does not match any declared command: ${entry}`,
        path: manifestPath,
      });
    }
  }

  return { findings, advisories };
}
