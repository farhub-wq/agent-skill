/**
 * G1 静态检查：纯文本与清单分析，不调用模型、不执行技能代码。
 * 目标是在技能目录被复制或安装之前，拦截文档中列出的四类绕过手段。
 */
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

/** 不约束上界的版本范围，只告警不拦截。 */
const LOOSE_RANGES = new Set(['*', 'x', 'latest', '>=0.0.0', '>=0']);

/** 判断清单中的路径是否逃出技能目录（绝对路径或 ../ 开头）。 */
export function escapesSkillDir(entry: string): boolean {
  if (path.isAbsolute(entry)) return true;
  const normalized = path.posix.normalize(entry.replace(/\\/g, '/'));
  return normalized === '..' || normalized.startsWith('../');
}

/** 判断 exec 命令文本是否引用了某个脚本（兼容 ./scripts/x.js 写法）。 */
function commandCoversScript(command: string, script: string): boolean {
  const normalized = command.replace(/\\/g, '/');
  return normalized.includes(script) || normalized.includes(`./${script}`);
}

/**
 * 执行 G1 静态检查。
 * 覆盖四类绕过：宿主预处理命令、未声明的工具/脚本、路径逃逸、未声明网络出口，
 * 另外检查依赖范围是否有效或过宽。
 */
export function runG1(source: SkillSource): Finding[] {
  const findings: Finding[] = [];
  const manifest = source.manifest;
  const skillPath = `${source.dir}/SKILL.md`;
  const manifestPath = `${source.dir}/skill.yaml`;
  const fullText = `${source.skillMd.raw}\n${source.manifestRaw}`;

  // 1) 宿主预处理命令会先于模型执行，必须直接拒绝。
  for (const hit of findPreprocessingCommands(source.skillMd.raw)) {
    findings.push(
      finding('preprocessing-command', `SKILL.md executes a host preprocessing command on line ${hit.line}`, {
        path: skillPath,
        evidence: hit.command,
      }),
    );
  }

  // 2) frontmatter 声明的工具必须能在 skill.yaml 的 capabilities 中找到。
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

  // 3) 随技能附带的每个脚本都必须在 permissions.exec 中登记。
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

  // 4) SKILL.md 中引用的脚本必须真实存在且已登记。
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

  // 5) 文件系统权限不得逃出技能目录。
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

  // 6) 出现 URL 或有 net 能力时，必须声明 permissions.net 白名单。
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

  // 7) 依赖范围必须合法；无上界范围只给 warning。
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
