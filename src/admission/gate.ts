/**
 * 准入门禁编排：依次执行 G1/G2，full 模式再执行 G3/G4，汇总为唯一裁决。
 * 这是宿主执行 `!`command`` 预处理之前唯一的强制检查点。
 */
import type { SkillSource } from '../manifest/parse.js';
import { createTracer, type Tracer } from '../trace/tracer.js';
import type { TraceEvent } from '../trace/events.js';
import {
  dedupeFindings,
  sortFindings,
  type Advisory,
  type Finding,
  type GateName,
  type GateOutcome,
} from './findings.js';
import { runG1 } from './g1-static.js';
import { runG2 } from './g2-semantic.js';
import { runG3 } from './g3-sandbox.js';
import { runG4 } from './g4-manifest.js';
import { tierForTrust, type TrustTier } from './tier.js';

/** install 只做静态检查；full 额外做沙箱试跑与分级对账。 */
export type GateMode = 'install' | 'full';

export interface AdmissionOptions {
  /** 默认 install。 */
  gate?: GateMode;
  /** 未注入时内部新建 tracer，报告会带上本次事件。 */
  tracer?: Tracer;
}

/** 完整的准入报告，可直接持久化为证据或输出给 CLI。 */
export interface AdmissionReport {
  skill: string;
  version: string;
  trust: string;
  trustTier: TrustTier;
  gate: GateMode;
  verdict: 'allow' | 'deny';
  gates: GateOutcome[];
  findings: Finding[];
  advisories: Advisory[];
  trace: readonly TraceEvent[];
}

/** 裁决为 deny 时抛出，携带完整报告供上层处理。 */
export class AdmissionDeniedError extends Error {
  constructor(readonly report: AdmissionReport) {
    super(
      `admission denied for ${report.skill}@${report.version}: ${report.findings
        .filter((item) => item.severity === 'error')
        .map((item) => item.code)
        .join(', ')}`,
    );
    this.name = 'AdmissionDeniedError';
  }
}

/** 将单道门的结果封装为 GateOutcome；只要存在 error 级发现即判 fail。 */
function outcome(
  gate: GateName,
  startedAt: number,
  findings: Finding[],
  advisories: Advisory[],
): GateOutcome {
  const failed = findings.some((item) => item.severity === 'error');
  return {
    gate,
    status: failed ? 'fail' : 'pass',
    findings,
    advisories,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 执行准入流程并返回报告，不直接抛错（抛错交给 assertAdmitted）。
 * 步骤：G1 静态 → G2 规则 →（full）G3 沙箱 → G4 分级 → 汇总去重 → 裁决。
 */
export async function runAdmission(
  source: SkillSource,
  options: AdmissionOptions = {},
): Promise<AdmissionReport> {
  const gate = options.gate ?? 'install';
  const tracer = options.tracer ?? createTracer();
  const trustTier = tierForTrust(source.manifest.trust);

  tracer.emit('admission.start', {
    skill: source.manifest.name,
    version: source.manifest.version,
    gate,
    trust: source.manifest.trust,
    trustTier,
  });

  const gates: GateOutcome[] = [];

  // G1：纯静态检查，必须先跑，成本最低且能拦住预处理命令。
  const g1Start = Date.now();
  const g1 = runG1(source);
  gates.push(outcome('G1', g1Start, g1, []));

  // G2：规则化语义比对，不依赖模型。
  const g2Start = Date.now();
  const g2 = runG2(source);
  gates.push(outcome('G2', g2Start, g2.findings, g2.advisories));

  // 只有 full 模式才付出沙箱试跑与分级对账的成本。
  if (gate === 'full') {
    const g3Start = Date.now();
    const g3 = await runG3(source, { tracer });
    gates.push(outcome('G3', g3Start, g3.findings, g3.advisories));

    const g4Start = Date.now();
    const g4 = runG4(source);
    gates.push(outcome('G4', g4Start, g4.findings, g4.advisories));
  }

  // 每道门的结果单独打点，便于定位是哪一道拒绝。
  for (const result of gates) {
    tracer.emit('admission.gate', {
      gate: result.gate,
      status: result.status,
      findings: result.findings.map((item) => item.code),
      advisories: result.advisories.map((item) => item.id),
      durationMs: result.durationMs,
    });
  }

  // 汇总所有门的发现：先去重再排序，保证报告稳定可复现。
  const findings = sortFindings(dedupeFindings(gates.flatMap((result) => result.findings)));
  const advisories = gates.flatMap((result) => result.advisories);
  const verdict = findings.some((item) => item.severity === 'error') ? 'deny' : 'allow';

  tracer.emit('admission.verdict', {
    skill: source.manifest.name,
    verdict,
    findings: findings.map((item) => item.code),
    gate,
  });

  return {
    skill: source.manifest.name,
    version: source.manifest.version,
    trust: source.manifest.trust,
    trustTier,
    gate,
    verdict,
    gates,
    findings,
    advisories,
    trace: tracer.events(),
  };
}

/** 裁决不是 allow 时抛出 AdmissionDeniedError。 */
export function assertAdmitted(report: AdmissionReport): void {
  if (report.verdict !== 'allow') throw new AdmissionDeniedError(report);
}

export type { Advisory, Finding, GateName, GateOutcome } from './findings.js';
