import { describe, expect, it } from 'vitest';
import {
  allowedToolsOf,
  baseToolName,
  loadSkillSource,
  listScripts,
  parseManifest,
  parseSkillMarkdown,
} from '../../src/manifest/parse.js';
import { assertValidManifest, validateManifest } from '../../src/manifest/validate.js';
import { exampleDir, makeManifest } from '../helpers.js';

const VALID_SKILL = `---
name: demo-skill
description: Use when testing the parser.
allowed-tools: Read, Bash(git:*)
license: MIT
---

# Demo
`;

describe('parseSkillMarkdown', () => {
  it('keeps the raw document while accepting extra frontmatter keys', () => {
    const document = parseSkillMarkdown(VALID_SKILL);
    expect(document.frontmatter.name).toBe('demo-skill');
    expect(document.frontmatter['allowed-tools']).toBe('Read, Bash(git:*)');
    expect(document.body).toBe('# Demo');
    expect(document.raw).toContain('license: MIT');
  });

  it('rejects a document without frontmatter', () => {
    expect(() => parseSkillMarkdown('# Demo')).toThrow(/must start with YAML frontmatter/);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseSkillMarkdown('---\nname: [unclosed\n---\n')).toThrow(/invalid frontmatter YAML/);
  });

  it('rejects a missing description', () => {
    expect(() => parseSkillMarkdown('---\nname: demo\n---\n')).toThrow(/description/);
  });

  it('rejects a non-kebab-case name', () => {
    expect(() => parseSkillMarkdown('---\nname: Demo_Skill\ndescription: Use when x.\n---\n')).toThrow(
      /kebab-case/,
    );
  });
});

describe('parseManifest', () => {
  it('defaults permissions and trust', () => {
    const manifest = parseManifest('name: demo\nversion: 1.0.0\ncapabilities: [fs.read]\n');
    expect(manifest.trust).toBe('community');
    expect(manifest.permissions).toEqual({ fs: [], net: [], exec: [], data: [], irreversible: [] });
    expect(manifest.requires).toEqual({});
  });

  it('rejects an unknown trust level', () => {
    expect(() =>
      parseManifest('name: demo\nversion: 1.0.0\ncapabilities: [fs.read]\ntrust: trusted\n'),
    ).toThrow(/trust/);
  });

  it('rejects an empty capability list', () => {
    expect(() => parseManifest('name: demo\nversion: 1.0.0\ncapabilities: []\n')).toThrow(
      /capabilities/,
    );
  });
});

describe('frontmatter helpers', () => {
  it('normalizes allowed-tools from string and array forms', () => {
    expect(allowedToolsOf({ 'allowed-tools': 'Read, Bash(git:*)' })).toEqual(['Read', 'Bash(git:*)']);
    expect(allowedToolsOf({ allowedTools: ['Read', ' Write '] })).toEqual(['Read', 'Write']);
    expect(allowedToolsOf({})).toEqual([]);
  });

  it('strips Claude-style argument scoping', () => {
    expect(baseToolName('Bash(git:*)')).toBe('Bash');
    expect(baseToolName('Read')).toBe('Read');
  });
});

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(validateManifest(makeManifest())).toEqual([]);
  });

  it('reports invalid versions, duplicates, self-conflicts and bad ranges', () => {
    const manifest = makeManifest({
      version: '1.0',
      capabilities: ['fs.read', 'fs.read'],
      conflicts: ['demo-skill'],
      requires: { other: 'not-a-range' },
    });
    const issues = validateManifest(manifest);
    const fields = issues.map((issue) => issue.field);
    expect(fields).toContain('version');
    expect(fields).toContain('capabilities');
    expect(fields).toContain('conflicts');
    expect(fields).toContain('requires.other');
    expect(() => assertValidManifest(manifest)).toThrow(/version/);
  });
});

describe('skill sources', () => {
  it('lists shipped scripts and loads the example', async () => {
    expect(await listScripts(exampleDir)).toEqual(['scripts/reconcile.mjs']);
    const source = await loadSkillSource(exampleDir);
    expect(source.manifest.name).toBe('invoice-reconcile');
    expect(source.manifest.trust).toBe('certified');
    expect(source.skillMd.frontmatter.description).toMatch(/^Use when/);
    expect(source.scripts).toEqual(['scripts/reconcile.mjs']);
  });

  it('returns no scripts when the directory has none', async () => {
    expect(await listScripts(exampleDir.replace('invoice-reconcile', 'missing-dir'))).toEqual([]);
  });
});
