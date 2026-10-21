/**
 * 清单解析：读取 `SKILL.md` 与 `skill.yaml`，并把两者转换成运行时可直接使用的结构。
 * 这里只做解析与格式校验，不做安全判定；安全判定属于 admission 层。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  SkillFrontmatterSchema,
  SkillManifestSchema,
  type SkillManifest,
} from './schema.js';

/** 清单解析错误，带上出错文件路径，便于 CLI 直接展示。 */
export class ManifestError extends Error {
  constructor(
    message: string,
    readonly filePath = 'SKILL.md',
  ) {
    super(`${filePath}: ${message}`);
    this.name = 'ManifestError';
  }
}

/** `SKILL.md` 的解析结果；`raw` 保留原文，供 G1 扫描预处理命令。 */
export interface SkillDocument {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

/** 一个技能目录的完整输入：文档、运行时清单与已登记的脚本列表。 */
export interface SkillSource {
  dir: string;
  skillMd: SkillDocument;
  manifest: SkillManifest;
  manifestRaw: string;
  /** 相对技能目录的 POSIX 风格路径，例如 `scripts/task.mjs`。 */
  scripts: string[];
}

// 匹配文件开头的 YAML frontmatter，并捕获正文部分。
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** 把 zod 的多条 issue 压成一行，方便 CLI 与测试断言。 */
function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

export interface ParseOptions {
  /** 出错时展示的文件路径，默认 `SKILL.md`。 */
  filePath?: string;
}

/**
 * 解析 `SKILL.md`，拆出 frontmatter 与正文。
 * 步骤：去 BOM -> 匹配 `---` 分隔块 -> 解析 YAML -> 用最小 schema 校验。
 */
export function parseSkillMarkdown(raw: string, options: ParseOptions = {}): SkillDocument {
  const filePath = options.filePath ?? 'SKILL.md';
  // 去掉 UTF-8 BOM，否则首行 `---` 无法被正则匹配。
  const text = raw.replace(/^\uFEFF/, '');
  // frontmatter 必须位于文件开头，否则视为格式错误。
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    throw new ManifestError('SKILL.md must start with YAML frontmatter', filePath);
  }

  // 只解析 YAML 文本，不执行其中的任何内容。
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new ManifestError(`invalid frontmatter YAML: ${(error as Error).message}`, filePath);
  }
  // frontmatter 必须是映射，数组或标量都无法承载 name/description。
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ManifestError('frontmatter must be a YAML mapping', filePath);
  }

  // 用最小 schema 校验，同时把未知字段留在原对象里供扫描。
  try {
    SkillFrontmatterSchema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ManifestError(`invalid frontmatter: ${formatZodError(error)}`, filePath);
    }
    throw error;
  }

  return {
    path: filePath,
    frontmatter: data as Record<string, unknown>,
    body: (match[2] ?? '').trim(),
    raw: text,
  };
}

/**
 * 解析 `skill.yaml`。schema 负责类型、默认值与枚举校验；
 * 版本范围、重复能力等语义问题留给 `validateManifest`。
 */
export function parseManifest(raw: string, options: ParseOptions = {}): SkillManifest {
  const filePath = options.filePath ?? 'skill.yaml';
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    throw new ManifestError(`invalid YAML: ${(error as Error).message}`, filePath);
  }
  try {
    return SkillManifestSchema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ManifestError(`invalid manifest: ${formatZodError(error)}`, filePath);
    }
    throw error;
  }
}

/**
 * 读取 `allowed-tools` 声明。兼容数组与逗号/空格分隔的字符串两种写法，
 * 返回去空白后的工具名列表；未声明时返回空数组。
 */
export function allowedToolsOf(frontmatter: Record<string, unknown>): string[] {
  // 同时兼容 kebab-case 与 camelCase 两种常见写法。
  const value = frontmatter['allowed-tools'] ?? frontmatter['allowedTools'];
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** 去掉 Claude 风格的参数限定，例如 `Bash(git:*)` 只保留 `Bash`。 */
export function baseToolName(entry: string): string {
  const index = entry.indexOf('(');
  return (index === -1 ? entry : entry.slice(0, index)).trim();
}

/**
 * 递归扫描 `scripts/` 目录，返回相对技能目录的 POSIX 路径。
 * 跳过隐藏文件与隐藏目录；目录不存在时返回空列表，而不是报错。
 */
export async function listScripts(skillDir: string): Promise<string[]> {
  const scriptsDir = path.join(skillDir, 'scripts');
  const found: string[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      // `scripts/` 可选，不存在时按“没有脚本”处理。
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const nextAbsolute = path.join(absolute, entry.name);
      const nextRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(nextAbsolute, nextRelative);
      } else if (entry.isFile()) {
        found.push(nextRelative);
      }
    }
  }

  await walk(scriptsDir, 'scripts');
  return found.sort();
}

/**
 * 加载一个技能目录：并行读取两个清单文件，再分别解析并扫描脚本。
 * 任一步失败都抛出带文件路径的 `ManifestError`。
 */
export async function loadSkillSource(dir: string): Promise<SkillSource> {
  const absoluteDir = path.resolve(dir);
  let skillRaw: string;
  let manifestRaw: string;
  // 并行读取，减少启动延迟；失败时统一包装成 ManifestError。
  try {
    [skillRaw, manifestRaw] = await Promise.all([
      readFile(path.join(absoluteDir, 'SKILL.md'), 'utf8'),
      readFile(path.join(absoluteDir, 'skill.yaml'), 'utf8'),
    ]);
  } catch (error) {
    throw new ManifestError(
      `cannot read skill source: ${(error as Error).message}`,
      absoluteDir,
    );
  }

  return {
    dir: absoluteDir,
    skillMd: parseSkillMarkdown(skillRaw, { filePath: path.join(absoluteDir, 'SKILL.md') }),
    manifest: parseManifest(manifestRaw, { filePath: path.join(absoluteDir, 'skill.yaml') }),
    manifestRaw,
    scripts: await listScripts(absoluteDir),
  };
}
