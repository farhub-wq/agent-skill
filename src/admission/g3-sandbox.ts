import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillSource } from '../manifest/parse.js';
import { tokenizeCommand, runSandboxed, type SandboxLimits } from '../runtime/sandbox.js';
import type { Tracer } from '../trace/tracer.js';
import { finding, type Advisory, type Finding } from './findings.js';

export interface G3Options {
  tracer: Tracer;
  limits?: Partial<SandboxLimits>;
}

export interface G3Run {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  egressBlocked: boolean;
}

export interface G3Result {
  findings: Finding[];
  advisories: Advisory[];
  runs: G3Run[];
}

/**
 * G3 executes declared commands in a throwaway copy of the skill directory.
 * The sandbox is a best-effort fallback, not a security boundary.
 */
export async function runG3(source: SkillSource, options: G3Options): Promise<G3Result> {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const runs: G3Run[] = [];

  for (const command of source.manifest.permissions.exec) {
    const argv = tokenizeCommand(command);
    if (argv[0] !== 'node' && argv[0] !== 'node.exe') {
      advisories.push({
        id: 'g3-unsupported-command',
        message: `sandbox trial skipped for non-node command: ${command}`,
        path: `${source.dir}/skill.yaml`,
      });
      continue;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-skill-g3-'));
    try {
      cpSync(source.dir, tempDir, { recursive: true });
      const result = await runSandboxed({
        command,
        cwd: tempDir,
        allowRead: [tempDir],
        allowWrite: [tempDir],
        tracer: options.tracer,
        limits: options.limits,
      });

      runs.push({
        command,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        egressBlocked: result.egressBlocked,
      });

      if (result.egressBlocked) {
        findings.push(
          finding('network-egress', 'sandbox trial detected a blocked network egress attempt', {
            path: `${source.dir}/skill.yaml`,
            evidence: command,
          }),
        );
      }
      if (!result.ok) {
        findings.push(
          finding('dependency-risk', `declared command failed in the sandbox trial (exit ${String(result.exitCode)})`, {
            path: `${source.dir}/skill.yaml`,
            evidence: `${command} :: ${result.stderr.slice(0, 400)}`,
          }),
        );
      }
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of our own temp directory
      }
    }
  }

  return { findings, advisories, runs };
}
