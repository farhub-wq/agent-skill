import { baseToolName } from '../manifest/parse.js';

export interface PreprocessingCommand {
  command: string;
  line: number;
}

const PREPROCESSING_PATTERN = /!`([^`\r\n]+)`/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s`"')\]]+/gi;
const SCRIPT_REFERENCE_PATTERN = /(?:^|[\s"'`(=])((?:\.\/)?scripts\/[A-Za-z0-9._/-]+)/g;
const SENSITIVE_PATTERN = /\b(secrets?|tokens?|credentials?|api[_-]?key|passwords?)\b/i;
const WRITE_VERB_PATTERN = /\b(write|save|modify|delete|overwrite|mutate)\b/i;
const EXEC_VERB_PATTERN = /\b(run|execute|spawn|shell|subprocess)\b/i;

/**
 * Host-side preprocessing executes `!`command`` before the model sees any
 * token. This scanner is the reason admission must run before installation.
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

export function toolFamily(tool: string): string {
  const base = baseToolName(tool);
  return TOOL_FAMILIES[base] ?? base.toLowerCase();
}

export function declaredToolFamilies(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter['allowed-tools'] ?? frontmatter['allowedTools'];
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
  return entries.filter((entry) => entry.trim().length > 0).map(toolFamily);
}

export function findUrls(text: string): string[] {
  return [...new Set([...text.matchAll(URL_PATTERN)].map((match) => match[0]))];
}

export function findScriptReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(SCRIPT_REFERENCE_PATTERN)) {
    const raw = (match[1] ?? '').replace(/\\/g, '/');
    refs.add(raw.startsWith('./') ? raw.slice(2) : raw);
  }
  return [...refs].sort();
}

export function mentionsSensitiveData(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}

export function mentionsWrite(text: string): boolean {
  return WRITE_VERB_PATTERN.test(text);
}

export function mentionsExec(text: string): boolean {
  return EXEC_VERB_PATTERN.test(text);
}

export function hasCapability(capabilities: readonly string[], family: string): boolean {
  const normalized = capabilities.map((capability) => capability.toLowerCase());
  if (normalized.includes(family)) return true;
  const group = family.split('.')[0] ?? family;
  return normalized.includes(group) || normalized.includes(`${group}.*`);
}
