import type { AdmissionReport } from '../admission/gate.js';
import type { Finding } from '../admission/findings.js';

export const EXIT = {
  ok: 0,
  usage: 1,
  denied: 2,
  permission: 3,
  failure: 4,
} as const;

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printFinding(item: Finding): void {
  const location = item.path === undefined ? '' : ` ${item.path}`;
  const evidence = item.evidence === undefined ? '' : ` (${item.evidence})`;
  console.log(`  [${item.severity}] ${item.code}${location}: ${item.message}${evidence}`);
}

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
