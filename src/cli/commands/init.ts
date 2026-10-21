/**
 * init 命令：生成技能骨架（SKILL.md、skill.yaml、cases/example.json）。
 * 目录名必须为 kebab-case，直接作为技能名。
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT } from '../shared.js';

/** SKILL.md 模板：description 只写触发条件，运行时元数据放 skill.yaml。 */
const SKILL_TEMPLATE = (name: string): string => `---
name: ${name}
description: Use when you need to describe the trigger conditions for this skill.
---

# ${name}

Describe the workflow here. Keep runtime metadata in skill.yaml.
`;

/** skill.yaml 模板：默认 community 分级，权限全空，需按需声明。 */
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

/** 示例评测用例。 */
const CASE_TEMPLATE = `{
  "id": "example",
  "input": {},
  "expected": {},
  "tags": ["smoke"],
  "negative": false
}
`;

/** 创建技能骨架；已存在 SKILL.md 时拒绝覆盖。 */
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
    // 预期情况：目录里还没有技能，可以继续初始化
  }

  // 三个文件一次生成：文档、清单、示例用例。
  await mkdir(path.join(dir, 'cases'), { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), SKILL_TEMPLATE(name), 'utf8');
  await writeFile(path.join(dir, 'skill.yaml'), MANIFEST_TEMPLATE(name), 'utf8');
  await writeFile(path.join(dir, 'cases', 'example.json'), CASE_TEMPLATE, 'utf8');

  console.log(`initialized ${name} in ${dir}`);
  console.log('next: agent-skill verify . --gate install');
  return EXIT.ok;
}
