/**
 * CLI 共享工具：统一退出码、JSON 输出与准入报告打印。
 */
import type { AdmissionReport } from '../admission/gate.js';
import type { Finding } from '../admission/findings.js';

/** 进程退出码：0 成功，1 用法错误，2 准入拒绝，3 权限不足，4 执行失败。 */
export const EXIT = {
  ok: 0,
  usage: 1,
  denied: 2,
  permission: 3,
  failure: 4,
} as const;

/** 以 2 空格缩进输出 JSON，便于脚本消费与人工阅读。 */
export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 打印单条发现：严重级、码、路径、说明与证据。 */
export function printFinding(item: Finding): void {
  const location = item.path === undefined ? '' : ` ${item.path}`;
  const evidence = item.evidence === undefined ? '' : ` (${item.evidence})`;
  console.log(`  [${item.severity}] ${item.code}${location}: ${item.message}${evidence}`);
}

/** 打印完整准入报告：技能信息、各门耗时、发现项、建议与最终裁决。 */
export function printReport(report: AdmissionReport): void {
  console.log(
    `skill: ${report.skill}@${report.version}  trust: ${report.trust} (${report.trustTier})  gate: ${report.gate}`,
  );
  for (const gate of report.gates) {
    console.log(`  ${gate.gate} ${gate.status} (${gate.durationMs}ms)`);
  }
  for (const item of report.findings) printFinding(item);
  for (const advisory of report.advisories) {
    console.log(`  [advisory] ${advisory.id}: ${advisory.message}`);
  }
  console.log(`verdict: ${report.verdict}`);
}
