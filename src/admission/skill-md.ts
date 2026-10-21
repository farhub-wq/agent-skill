/**
 * SKILL.md 静态扫描工具：用正则提取预处理命令、URL、脚本引用等信号。
 * 这里只做文本分析，不执行任何技能代码。
 */
import { baseToolName } from '../manifest/parse.js';

/** 一条宿主预处理命令及其行号。 */
export interface PreprocessingCommand {
  command: string;
  line: number;
}

/** 匹配 !`command` 形式的宿主预处理指令。 */
const PREPROCESSING_PATTERN = /!`([^`\r\n]+)`/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s`"')\]]+/gi;
const SCRIPT_REFERENCE_PATTERN = /(?:^|[\s"'`(=])((?:\.\/)?scripts\/[A-Za-z0-9._/-]+)/g;
const SENSITIVE_PATTERN = /\b(secrets?|tokens?|credentials?|api[_-]?key|passwords?)\b/i;
const WRITE_VERB_PATTERN = /\b(write|save|modify|delete|overwrite|mutate)\b/i;
const EXEC_VERB_PATTERN = /\b(run|execute|spawn|shell|subprocess)\b/i;

/**
 * 扫描宿主预处理命令。宿主会在模型看到任何 token 之前执行 `!`command``，
 * 所以准入必须发生在安装之前，这是本扫描器存在的根本原因。
 */
export function findPreprocessingCommands(text: string): PreprocessingCommand[] {
  const commands: PreprocessingCommand[] = [];
  for (const match of text.matchAll(PREPROCESSING_PATTERN)) {
    const index = match.index ?? 0;
    commands.push({
      command: match[1] ?? '',
      line: text.slice(0, index).split(/\r?\n/).length,
    });
  }
  return commands;
}

/** 宿主工具名到权限族的映射；Bash 等执行类工具统一归到 exec。 */
export const TOOL_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  Read: 'fs.read',
  Write: 'fs.write',
  Edit: 'fs.write',
  Bash: 'exec',
  WebFetch: 'net',
  WebSearch: 'net',
  NotebookEdit: 'exec',
  Task: 'task',
});

/** 去掉工具名的参数后缀并映射到权限族；未知工具回退为小写基名。 */
export function toolFamily(tool: string): string {
  const base = baseToolName(tool);
  return TOOL_FAMILIES[base] ?? base.toLowerCase();
}

/** 读取 frontmatter 中 allowed-tools/allowedTools 声明并归一化为权限族。 */
export function declaredToolFamilies(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter['allowed-tools'] ?? frontmatter['allowedTools'];
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
  return entries.filter((entry) => entry.trim().length > 0).map(toolFamily);
}

/** 提取文本中的 http(s) URL，去重后返回。 */
export function findUrls(text: string): string[] {
  return [...new Set([...text.matchAll(URL_PATTERN)].map((match) => match[0]))];
}

/** 提取对 scripts/ 目录的引用，统一斜杠并去掉 ./ 前缀，排序后返回。 */
export function findScriptReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(SCRIPT_REFERENCE_PATTERN)) {
    const raw = (match[1] ?? '').replace(/\\/g, '/');
    refs.add(raw.startsWith('./') ? raw.slice(2) : raw);
  }
  return [...refs].sort();
}

/** 是否提及密钥、令牌等敏感数据关键词。 */
export function mentionsSensitiveData(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}

/** 是否出现写文件类动词。 */
export function mentionsWrite(text: string): boolean {
  return WRITE_VERB_PATTERN.test(text);
}

/** 是否出现执行命令类动词。 */
export function mentionsExec(text: string): boolean {
  return EXEC_VERB_PATTERN.test(text);
}

/**
 * 判断清单能力是否覆盖某个权限族。
 * 支持三种写法：精确匹配 fs.read、组匹配 fs、通配 fs.*。
 */
export function hasCapability(capabilities: readonly string[], family: string): boolean {
  const normalized = capabilities.map((capability) => capability.toLowerCase());
  if (normalized.includes(family)) return true;
  const group = family.split('.')[0] ?? family;
  return normalized.includes(group) || normalized.includes(`${group}.*`);
}
