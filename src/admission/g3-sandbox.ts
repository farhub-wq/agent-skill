/**
 * G3 沙箱试跑：在技能目录的临时副本中执行声明的命令，观察是否失败或尝试外连。
 * 沙箱只是尽力而为的降级手段，不是安全边界。
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillSource } from '../manifest/parse.js';
import { tokenizeCommand, runSandboxed, type SandboxLimits } from '../runtime/sandbox.js';
import type { Tracer } from '../trace/tracer.js';
import { finding, type Advisory, type Finding } from './findings.js';

export interface G3Options {
  /** 用于记录沙箱执行事件。 */
  tracer: Tracer;
  /** 可覆盖默认沙箱限制（超时、内存、输出等）。 */
  limits?: Partial<SandboxLimits>;
}

/** 单条命令的试跑结果。 */
export interface G3Run {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** 沙箱是否拦截到网络外连尝试。 */
  egressBlocked: boolean;
}

export interface G3Result {
  findings: Finding[];
  advisories: Advisory[];
  runs: G3Run[];
}

/**
 * 执行 G3 沙箱试跑。
 * 只支持 node 命令；其他命令跳过并给出建议，不会因此拒绝准入。
 */
export async function runG3(source: SkillSource, options: G3Options): Promise<G3Result> {
  const findings: Finding[] = [];
  const advisories: Advisory[] = [];
  const runs: G3Run[] = [];

  for (const command of source.manifest.permissions.exec) {
    // 当前沙箱只能可靠地限制 node 子进程，其他解释器直接跳过。
    const argv = tokenizeCommand(command);
    if (argv[0] !== 'node' && argv[0] !== 'node.exe') {
      advisories.push({
        id: 'g3-unsupported-command',
        message: `sandbox trial skipped for non-node command: ${command}`,
        path: `${source.dir}/skill.yaml`,
      });
      continue;
    }

    // 在系统临时目录建副本，所有读写权限都收敛到副本内部。
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

      // 试跑期间出现被拦截的外连 → network-egress。
      if (result.egressBlocked) {
        findings.push(
          finding('network-egress', 'sandbox trial detected a blocked network egress attempt', {
            path: `${source.dir}/skill.yaml`,
            evidence: command,
          }),
        );
      }
      // 命令在沙箱中失败 → dependency-risk，附带截断后的 stderr。
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
        // 清理自己创建的临时目录，失败不影响准入结论
      }
    }
  }

  return { findings, advisories, runs };
}
