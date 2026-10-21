import type { SkillSource } from '../manifest/parse.js';
import { finding, type Advisory, type Finding } from './findings.js';
import {
  findScriptReferences,
  findUrls,
  hasCapability,
  mentionsExec,
  mentionsSensitiveData,
  mentionsWrite,
} from './skill-md.js';

export interface G2Result {
  findings: Finding[];
  advisories: Advisory[];
}

const MAX_DESCRIPTION_WORDS = 500;

/**
 * G2 is rule-based on purpose: the plan's P0 ships without a model dependency,
 * and a semantic judge must never be the only decision maker.
 */
export function runG2(source: SkillSource): G2Result {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const skillPath = `${source.dir}/SKILL.md`;
  const manifestPath = `${source.dir}/skill.yaml`;
  const manifest = source.manifest;
  const description = String(source.skillMd.frontmatter['description'] ?? '');
  const body = source.skillMd.body;

  if (!description.startsWith('Use when')) {
    advisories.push({
      id: 'description-trigger',
      message: 'description should start with "Use when" and describe trigger conditions only',
      path: skillPath,
    });
  }
  const words = description.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_DESCRIPTION_WORDS) {
    advisories.push({
      id: 'description-length',
      message: `description is ${words} words; keep it under ${MAX_DESCRIPTION_WORDS}`,
      path: skillPath,
    });
  }

  if (mentionsWrite(body) && !hasCapability(manifest.capabilities, 'fs.write')) {
    findings.push(
      finding('undeclared-tool', 'SKILL.md instructs the model to write files without an fs.write capability', {
        path: skillPath,
      }),
    );
  }
  if (mentionsExec(body) && !hasCapability(manifest.capabilities, 'exec')) {
    findings.push(
      finding('undeclared-tool', 'SKILL.md instructs the model to execute commands without an exec capability', {
        path: skillPath,
      }),
    );
  }
  if (findUrls(body).length > 0 && manifest.permissions.net.length === 0) {
    findings.push(
      finding('network-egress', 'SKILL.md instructs the model to reach a network endpoint without permissions.net', {
        path: skillPath,
      }),
    );
  }
  if (mentionsSensitiveData(body) && !manifest.permissions.data.includes('secrets')) {
    advisories.push({
      id: 'sensitive-data-undeclared',
      message: 'SKILL.md mentions credentials but permissions.data does not declare secrets',
      path: manifestPath,
    });
  }

  for (const reference of findScriptReferences(body)) {
    if (!source.scripts.includes(reference)) {
      findings.push(
        finding('unlisted-script', `SKILL.md references ${reference}, which is not shipped`, {
          path: skillPath,
          evidence: reference,
        }),
      );
    }
  }

  if (manifest.permissions.exec.length > 0 && !hasCapability(manifest.capabilities, 'exec')) {
    advisories.push({
      id: 'exec-capability-missing',
      message: 'permissions.exec is declared but capabilities has no exec entry',
      path: manifestPath,
    });
  }

  return { findings, advisories };
}
