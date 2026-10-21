import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAdmission } from '../../admission/gate.js';
import { permissionCeiling, tierForTrust } from '../../admission/tier.js';
import { createLifecycle } from '../../lifecycle/skill.js';
import { loadSkillSource } from '../../manifest/parse.js';
import { createRegistry, toRegisteredSkill } from '../../registry/registry.js';
import { runSandboxed } from '../../runtime/sandbox.js';
import { createJsonlLedger } from '../../trace/ledger.js';
import { createTracer } from '../../trace/tracer.js';
import { EXIT, printReport, writeJson } from '../shared.js';

export interface RunOptions {
  dir: string;
  input?: string;
  json: boolean;
}

export async function runCommand(options: RunOptions): Promise<number> {
  const source = await loadSkillSource(options.dir);
  const ledger = createJsonlLedger(path.join(process.cwd(), '.agent-skill', 'trace.jsonl'));
  const tracer = createTracer({ sink: ledger });
  tracer.emit('run.start', { skill: source.manifest.name, dir: source.dir });

  const report = await runAdmission(source, { gate: 'install', tracer });
  if (report.verdict !== 'allow') {
    if (options.json) writeJson(report);
    else printReport(report);
    tracer.emit('run.end', { ok: false, reason: 'admission-denied' });
    return EXIT.denied;
  }

  const skill = toRegisteredSkill(source.manifest, source.dir, 'task');
  createRegistry([skill]).resolve(skill.manifest.name);

  const lifecycle = createLifecycle({ skill: skill.manifest.name, tracer });
  await lifecycle.transition('admitted');
  await lifecycle.transition('loaded');
  await lifecycle.transition('active');

  const tier = tierForTrust(source.manifest.trust);
  const ceiling = permissionCeiling(tier);
  if (!ceiling.exec || source.manifest.permissions.exec.length === 0) {
    console.error(
      `trust tier ${tier} (${source.manifest.trust}) does not permit script execution; ` +
        'raise trust only after G3/G4 evidence exists',
    );
    tracer.emit('run.end', { ok: false, reason: 'tier-denied' });
    await lifecycle.transition('disposed');
    return EXIT.permission;
  }

  const input = options.input === undefined ? '{}' : await readFile(path.resolve(options.input), 'utf8');
  const results: Array<{ command: string; ok: boolean; exitCode: number | null; stdout: string; stderr: string }> = [];

  for (const command of source.manifest.permissions.exec) {
    const result = await runSandboxed({
      command,
      cwd: source.dir,
      allowRead: [source.dir],
      allowWrite: [source.dir],
      stdin: input,
      tracer,
    });
    results.push({
      command,
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
    if (!result.ok) break;
  }

  await lifecycle.transition('disposed');
  const ok = results.length > 0 && results.every((result) => result.ok);
  tracer.emit('run.end', { ok });

  if (options.json) {
    writeJson({ ok, results, trace: tracer.events() });
  } else {
    for (const result of results) {
      if (result.stdout.length > 0) console.log(result.stdout);
      if (result.stderr.length > 0) console.error(result.stderr);
      if (!result.ok) console.error(`command failed (${String(result.exitCode)}): ${result.command}`);
    }
    console.log(`trace: ${path.join(process.cwd(), '.agent-skill', 'trace.jsonl')}`);
  }

  return ok ? EXIT.ok : EXIT.failure;
}
