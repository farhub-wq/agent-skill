/**
 * adapter 命令：不带 --hook 时输出 hooks 配置；带 --hook 时从 stdin 读入
 * Claude Code 的 hook 负载，走过滤链并输出 allow/deny 决策。
 */
import { claudeHookConfig, createClaudeAdapter, type ClaudeHookPayload } from '../../adapter/claude.js';
import { createDefaultFilters } from '../../filters/index.js';
import { loadSkillSource } from '../../manifest/parse.js';
import { toRegisteredSkill } from '../../registry/registry.js';
import { createTracer } from '../../trace/tracer.js';
import { EXIT, writeJson } from '../shared.js';

export interface AdapterOptions {
  dir?: string;
  hook: boolean;
}

/** 读取全部 stdin 内容，hook 负载通常由宿主通过管道传入。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 输出 hook 配置或处理一次 hook 调用。 */
export async function adapterCommand(options: AdapterOptions): Promise<number> {
  if (!options.hook) {
    writeJson(claudeHookConfig());
    return EXIT.ok;
  }

  if (options.dir === undefined) {
    console.error('adapter hooks require --dir <skill-dir>');
    return EXIT.usage;
  }

  // hook 模式必须显式指定技能目录，过滤规则来自该技能的清单。
  const source = await loadSkillSource(options.dir);
  const payload = JSON.parse(await readStdin()) as ClaudeHookPayload;
  const tracer = createTracer();
  const skill = toRegisteredSkill(source.manifest, source.dir, 'session');
  const adapter = createClaudeAdapter({
    skill,
    tracer,
    filters: createDefaultFilters({
      capabilities: source.manifest.capabilities,
      permissions: source.manifest.permissions,
      tracer,
    }),
  });

  // PreToolUse 返回 allow/deny；PostToolUse 只记录事件。
  const result =
    payload.hook_event_name === 'PostToolUse'
      ? await adapter.postToolUse(payload)
      : await adapter.preToolUse(payload);
  writeJson(result);
  return result.permissionDecision === 'deny' ? EXIT.denied : EXIT.ok;
}
