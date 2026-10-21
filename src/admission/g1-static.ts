import path from 'node:path';
import semver from 'semver';
import type { SkillSource } from '../manifest/parse.js';
import { finding, type Finding } from './findings.js';
import {
  declaredToolFamilies,
  findPreprocessingCommands,
  findScriptReferences,
  findUrls,
  hasCapability,
} from './skill-md.js';

const LOOSE_RANGES = new Set(['*', 'x', 'latest', '>=0.0.0', '>=0']);

export function escapesSkillDir(entry: string): boolean {
  if (path.isAbsolute(entry)) return true;
  const normalized = path.posix.normalize(entry.replace(/\\/g, '/'));
  return normalized === '..' || normalized.startsWith('../');
}

function commandCoversScript(command: string, script: string): boolean {
  const normalized = command.replace(/\\/g, '/');
  return normalized.includes(script) || normalized.includes(`./${script}`);
}

/**
 * G1 is purely static: no model, no execution. It must catch the four
 * documented bypass classes before a skill directory is copied anywhere.
 */
export function runG1(source: SkillSource): Finding[] {
  const findings: Finding[] = [];
  const manifest = source.manifest;
  const skillPath = `${source.dir}/SKILL.md`;
  const manifestPath = `${source.dir}/skill.yaml`;
  const fullText = `${source.skillMd.raw}\n${source.manifestRaw}`;

  for (const hit of findPreprocessingCommands(source.skillMd.raw)) {
    findings.push(
      finding('preprocessing-command', `SKILL.md executes a host preprocessing command on line ${hit.line}`, {
        path: skillPath,
        evidence: hit.command,
      }),
    );
  }

  for (const family of declaredToolFamilies(source.skillMd.frontmatter)) {
    if (!hasCapability(manifest.capabilities, family)) {
      findings.push(
        finding('undeclared-tool', `allowed-tools requests capability "${family}" not present in skill.yaml`, {
          path: skillPath,
          evidence: family,
        }),
      );
    }
  }

  for (const script of source.scripts) {
    if (!manifest.permissions.exec.some((command) => commandCoversScript(command, script))) {
      findings.push(
        finding('unlisted-script', `script ${script} is shipped but not declared in permissions.exec`, {
          path: manifestPath,
          evidence: script,
        }),
      );
    }
  }

  for (const reference of findScriptReferences(source.skillMd.body)) {
    if (!source.scripts.includes(reference)) {
      findings.push(
        finding('unlisted-script', `SKILL.md references missing script ${reference}`, {
          path: skillPath,
          evidence: reference,
        }),
      );
    } else if (!manifest.permissions.exec.some((command) => commandCoversScript(command, reference))) {
      findings.push(
        finding('unlisted-script', `SKILL.md runs ${reference} without declaring it in permissions.exec`, {
          path: skillPath,
          evidence: reference,
        }),
      );
    }
  }

  for (const entry of manifest.permissions.fs) {
    if (escapesSkillDir(entry)) {
      findings.push(
        finding('path-escape', `permissions.fs entry escapes the skill directory: ${entry}`, {
          path: manifestPath,
          evidence: entry,
        }),
      );
    }
  }

  for (const command of manifest.permissions.exec) {
    if (escapesSkillDir(command)) {
      findings.push(
        finding('path-escape', `permissions.exec references a path outside the skill directory`, {
          path: manifestPath,
          evidence: command,
        }),
      );
    }
  }

  const urls = findUrls(fullText);
  const netDeclared = manifest.permissions.net.length > 0;
  const netCapable = hasCapability(manifest.capabilities, 'net');
  if (urls.length > 0 && !netDeclared) {
    findings.push(
      finding('network-egress', 'skill references network endpoints without declaring permissions.net', {
        path: skillPath,
        evidence: urls[0],
      }),
    );
  } else if (netCapable && !netDeclared) {
    findings.push(
      finding('network-egress', 'skill declares network capability without a permissions.net allowlist', {
        path: manifestPath,
      }),
    );
  }

  for (const [name, range] of Object.entries(manifest.requires)) {
    if (semver.validRange(range) === null) {
      findings.push(
        finding('dependency-risk', `requires.${name} has an invalid semver range: ${range}`, {
          path: manifestPath,
          evidence: range,
        }),
      );
    } else if (LOOSE_RANGES.has(range.trim().toLowerCase())) {
      findings.push(
        finding('dependency-risk', `requires.${name} uses an unbounded range: ${range}`, {
          path: manifestPath,
          evidence: range,
          severity: 'warning',
        }),
      );
    }
  }

  return findings;
}
