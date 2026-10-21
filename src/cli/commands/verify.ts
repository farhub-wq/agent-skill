import { runAdmission, type GateMode } from '../../admission/gate.js';
import { loadSkillSource } from '../../manifest/parse.js';
import { EXIT, printReport, writeJson } from '../shared.js';

export interface VerifyOptions {
  dir: string;
  gate: GateMode;
  json: boolean;
}

export async function verifyCommand(options: VerifyOptions): Promise<number> {
  const source = await loadSkillSource(options.dir);
  const report = await runAdmission(source, { gate: options.gate });

  if (options.json) {
    writeJson(report);
  } else {
    printReport(report);
  }

  return report.verdict === 'allow' ? EXIT.ok : EXIT.denied;
}
