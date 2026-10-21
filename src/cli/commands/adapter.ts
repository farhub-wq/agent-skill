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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function adapterCommand(options: AdapterOptions): Promise<number> {
  if (!options.hook) {
    writeJson(claudeHookConfig());
    return EXIT.ok;
  }

  if (options.dir === undefined) {
    console.error('adapter hooks require --dir <skill-dir>');
    return EXIT.usage;
  }

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

  const result =
    payload.hook_event_name === 'PostToolUse'
      ? await adapter.postToolUse(payload)
      : await adapter.preToolUse(payload);
  writeJson(result);
  return result.permissionDecision === 'deny' ? EXIT.denied : EXIT.ok;
}
