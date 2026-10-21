/**
 * G2 语义检查：基于规则比对 SKILL.md 描述与清单声明，不依赖模型。
 * 语义判定只能作为辅助，永远不能成为唯一的放行依据。
 */
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

/** description 的词数上限，过长会稀释触发条件。 */
const MAX_DESCRIPTION_WORDS = 500;

/**
 * 执行 G2 规则检查。
 * 检查 description 是否只描述触发条件，以及正文是否隐含未声明的写文件、
 * 执行命令、网络访问或敏感数据使用。
 */
export function runG2(source: SkillSource): G2Result {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const skillPath = `${source.dir}/SKILL.md`;
  const manifestPath = `${source.dir}/skill.yaml`;
  const manifest = source.manifest;
  const description = String(source.skillMd.frontmatter['description'] ?? '');
  const body = source.skillMd.body;

  // description 应只写“何时使用”，不写能力介绍；不符合只给建议。
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

  // 正文要求写文件，但清单没有 fs.write 能力：属于未声明工具。
  if (mentionsWrite(body) && !hasCapability(manifest.capabilities, 'fs.write')) {
    findings.push(
      finding('undeclared-tool', 'SKILL.md instructs the model to write files without an fs.write capability', {
        path: skillPath,
      }),
    );
  }
  // 正文要求执行命令，但清单没有 exec 能力。
  if (mentionsExec(body) && !hasCapability(manifest.capabilities, 'exec')) {
    findings.push(
      finding('undeclared-tool', 'SKILL.md instructs the model to execute commands without an exec capability', {
        path: skillPath,
      }),
    );
  }
  // 正文出现 URL 却未声明网络白名单。
  if (findUrls(body).length > 0 && manifest.permissions.net.length === 0) {
    findings.push(
      finding('network-egress', 'SKILL.md instructs the model to reach a network endpoint without permissions.net', {
        path: skillPath,
      }),
    );
  }
  // 正文提及凭据但未声明 secrets 数据类；先告警，后续由 G4 按分级拦截。
  if (mentionsSensitiveData(body) && !manifest.permissions.data.includes('secrets')) {
    advisories.push({
      id: 'sensitive-data-undeclared',
      message: 'SKILL.md mentions credentials but permissions.data does not declare secrets',
      path: manifestPath,
    });
  }

  // 正文引用的脚本必须随技能一起分发。
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

  // 声明了 exec 权限却缺少 exec 能力，属于清单内部不一致，提示修正。
  if (manifest.permissions.exec.length > 0 && !hasCapability(manifest.capabilities, 'exec')) {
    advisories.push({
      id: 'exec-capability-missing',
      message: 'permissions.exec is declared but capabilities has no exec entry',
      path: manifestPath,
    });
  }

  return { findings, advisories };
}
