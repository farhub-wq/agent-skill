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

export type GateMode = 'install' | 'full';

export interface AdmissionOptions {
  gate?: GateMode;
  tracer?: Tracer;
}

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
 * Admission is the only enforcement point that runs before a host executes
 * `!`command`` preprocessing. Install mode is static; full mode adds G3/G4.
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

  const g1Start = Date.now();
  const g1 = runG1(source);
  gates.push(outcome('G1', g1Start, g1, []));

  const g2Start = Date.now();
  const g2 = runG2(source);
  gates.push(outcome('G2', g2Start, g2.findings, g2.advisories));

  if (gate === 'full') {
    const g3Start = Date.now();
    const g3 = await runG3(source, { tracer });
    gates.push(outcome('G3', g3Start, g3.findings, g3.advisories));

    const g4Start = Date.now();
    const g4 = runG4(source);
    gates.push(outcome('G4', g4Start, g4.findings, g4.advisories));
  }

  for (const result of gates) {
    tracer.emit('admission.gate', {
      gate: result.gate,
      status: result.status,
      findings: result.findings.map((item) => item.code),
      advisories: result.advisories.map((item) => item.id),
      durationMs: result.durationMs,
    });
  }

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

export function assertAdmitted(report: AdmissionReport): void {
  if (report.verdict !== 'allow') throw new AdmissionDeniedError(report);
}

export type { Advisory, Finding, GateName, GateOutcome } from './findings.js';
