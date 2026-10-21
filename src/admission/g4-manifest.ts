/**
 * G4 分级对账：将清单声明的权限与信任等级上限逐项比较。
 * 上限不是建议：T1/T2 在运行时永远拿不到脚本执行能力。
 */
import path from 'node:path';
import type { SkillSource } from '../manifest/parse.js';
import { finding, type Advisory, type Finding } from './findings.js';
import { escapesSkillDir } from './g1-static.js';
import { permissionCeiling, tierForTrust } from './tier.js';

/** G4 的输出：发现项与建议项。 */
export interface G4Result {
  findings: Finding[];
  advisories: Advisory[];
}

/**
 * 执行 G4 分级对账：
 * 1. 脚本执行、网络、secrets 是否超过当前信任等级上限；
 * 2. 文件系统路径是否在解析后仍落在技能目录内；
 * 3. exec 命令引用的脚本是否真实存在；
 * 4. irreversible 权限是否能对应到具体命令。
 */
export function runG4(source: SkillSource): G4Result {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const manifest = source.manifest;
  const manifestPath = `${source.dir}/skill.yaml`;
  const tier = tierForTrust(manifest.trust);
  const ceiling = permissionCeiling(tier);

  // 信任等级上限：T1/T2 不允许声明脚本执行。
  if (manifest.permissions.exec.length > 0 && !ceiling.exec) {
    findings.push(
      finding('undeclared-tool', `trust ${manifest.trust} (${tier}) cannot declare script execution`, {
        path: manifestPath,
      }),
    );
  }

  // 信任等级上限：T1/T2 不允许声明网络访问。
  if (manifest.permissions.net.length > 0 && !ceiling.net) {
    findings.push(
      finding('network-egress', `trust ${manifest.trust} (${tier}) cannot declare network access`, {
        path: manifestPath,
      }),
    );
  }

  // 只有 T4 允许访问 secrets。
  if (manifest.permissions.data.includes('secrets') && !ceiling.data.includes('secrets')) {
    findings.push(
      finding('undeclared-tool', `trust ${manifest.trust} (${tier}) cannot access secrets`, {
        path: manifestPath,
      }),
    );
  }

  // 双重路径检查：先查字面量，再查 resolve 后的真实位置（防符号链接/拼接绕过）。
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

  // exec 命令如果引用了 scripts/ 下的脚本，该脚本必须随包分发。
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

  // irreversible 权限应当能匹配到具体命令；对不上只提示，不拦截。
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
