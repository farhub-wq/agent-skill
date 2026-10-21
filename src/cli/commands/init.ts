import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT } from '../shared.js';

const SKILL_TEMPLATE = (name: string): string => `---
name: ${name}
description: Use when you need to describe the trigger conditions for this skill.
---

# ${name}

Describe the workflow here. Keep runtime metadata in skill.yaml.
`;

const MANIFEST_TEMPLATE = (name: string): string => `name: ${name}
version: 0.1.0
capabilities:
  - fs.read
requires: {}
conflicts: []
permissions:
  fs: []
  net: []
  exec: []
  data: []
  irreversible: []
trust: community
`;

const CASE_TEMPLATE = `{
  "id": "example",
  "input": {},
  "expected": {},
  "tags": ["smoke"],
  "negative": false
}
`;

export async function initCommand(target: string): Promise<number> {
  const dir = path.resolve(target);
  const name = path.basename(dir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(`directory name must be kebab-case to become a skill name: ${name}`);
    return EXIT.usage;
  }

  try {
    await access(path.join(dir, 'SKILL.md'));
    console.error(`SKILL.md already exists in ${dir}`);
    return EXIT.usage;
  } catch {
    // expected: no existing skill
  }

  await mkdir(path.join(dir, 'cases'), { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), SKILL_TEMPLATE(name), 'utf8');
  await writeFile(path.join(dir, 'skill.yaml'), MANIFEST_TEMPLATE(name), 'utf8');
  await writeFile(path.join(dir, 'cases', 'example.json'), CASE_TEMPLATE, 'utf8');

  console.log(`initialized ${name} in ${dir}`);
  console.log('next: agent-skill verify . --gate install');
  return EXIT.ok;
}
