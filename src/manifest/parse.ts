import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  SkillFrontmatterSchema,
  SkillManifestSchema,
  type SkillManifest,
} from './schema.js';

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly filePath = 'SKILL.md',
  ) {
    super(`${filePath}: ${message}`);
    this.name = 'ManifestError';
  }
}

export interface SkillDocument {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export interface SkillSource {
  dir: string;
  skillMd: SkillDocument;
  manifest: SkillManifest;
  manifestRaw: string;
  /** POSIX-style paths relative to the skill directory. */
  scripts: string[];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

export interface ParseOptions {
  filePath?: string;
}

export function parseSkillMarkdown(raw: string, options: ParseOptions = {}): SkillDocument {
  const filePath = options.filePath ?? 'SKILL.md';
  const text = raw.replace(/^\uFEFF/, '');
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    throw new ManifestError('SKILL.md must start with YAML frontmatter', filePath);
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new ManifestError(`invalid frontmatter YAML: ${(error as Error).message}`, filePath);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ManifestError('frontmatter must be a YAML mapping', filePath);
  }

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

export function allowedToolsOf(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter['allowed-tools'] ?? frontmatter['allowedTools'];
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Base tool name without Claude-style argument scoping, e.g. `Bash(git:*)` -> `Bash`. */
export function baseToolName(entry: string): string {
  const index = entry.indexOf('(');
  return (index === -1 ? entry : entry.slice(0, index)).trim();
}

export async function listScripts(skillDir: string): Promise<string[]> {
  const scriptsDir = path.join(skillDir, 'scripts');
  const found: string[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
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

export async function loadSkillSource(dir: string): Promise<SkillSource> {
  const absoluteDir = path.resolve(dir);
  let skillRaw: string;
  let manifestRaw: string;
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
