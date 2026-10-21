/**
 * eval 命令：full 准入 → 加载用例 → k 次评测 → 计算指标 → 写证据卡与锁。
 * 证据目录固定为 <skill>/evidence，--now 可固定 generated_at 以便复现。
 */
import path from 'node:path';
import { runAdmission } from '../../admission/gate.js';
import { loadCases } from '../../eval/case.js';
import { buildEvidenceCard, type EvidenceCard } from '../../eval/evidence.js';
import { l1FieldGrader } from '../../eval/grader.js';
import { computeMetrics } from '../../eval/metrics.js';
import { createScriptTarget, runEval } from '../../eval/runner.js';
import { writeEvidenceFiles } from '../../evidence/lock.js';
import { loadSkillSource } from '../../manifest/parse.js';
import { createTracer, type Tracer } from '../../trace/tracer.js';
import { HARNESS_VERSION } from '../../version.js';
import { EXIT, printReport, writeJson } from '../shared.js';

export interface EvalOptions {
  dir: string;
  k: number;
  now?: string;
  json: boolean;
  /** 测试与嵌入场景注入；CLI 自行创建。 */
  tracer?: Tracer;
}

/** 执行评测并写出证据文件。 */
export async function evalCommand(options: EvalOptions): Promise<number> {
  const source = await loadSkillSource(options.dir);
  const tracer = options.tracer ?? createTracer();
  // 评测必须走 full 门禁：G3 沙箱与 G4 分级都通过才有资格生成证据。
  const report = await runAdmission(source, { gate: 'full', tracer });

  if (report.verdict !== 'allow') {
    if (options.json) writeJson(report);
    else printReport(report);
    return EXIT.denied;
  }

  // 以第一条声明命令作为被测目标；没有命令就无法评测。
  const command = source.manifest.permissions.exec[0];
  if (command === undefined) {
    console.error('eval requires at least one permissions.exec entry to execute the skill');
    return EXIT.usage;
  }

  // 用例目录默认 cases，可在清单 eval 字段中覆盖。
  const casesDir = path.resolve(source.dir, source.manifest.eval ?? 'cases');
  const cases = await loadCases(casesDir);
  if (cases.length === 0) {
    console.error(`no eval cases found in ${casesDir}`);
    return EXIT.usage;
  }

  // 固定 --now 可让证据摘要在不同时间重跑时保持一致。
  const generatedAt = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(generatedAt.getTime())) {
    console.error(`invalid --now value: ${String(options.now)}`);
    return EXIT.usage;
  }

  // L1 字段评分：只比对用例 expected 中出现的业务字段。
  const run = await runEval(cases, {
    target: createScriptTarget({ dir: source.dir, command }),
    grader: l1FieldGrader(['status', 'outstanding', 'error', 'decision']),
    k: options.k,
    tracer,
  });
  const metrics = computeMetrics(run.cases);

  // 把本次 full 准入的各门结果固化进证据卡。
  const gates: Record<'G1' | 'G2' | 'G3' | 'G4', boolean | 'skipped'> = {
    G1: 'skipped',
    G2: 'skipped',
    G3: 'skipped',
    G4: 'skipped',
  };
  for (const gate of report.gates) {
    if (gate.status !== 'skipped') gates[gate.gate] = gate.status === 'pass';
  }

  const card: EvidenceCard = await buildEvidenceCard({
    skill: source.manifest.name,
    version: source.manifest.version,
    dir: source.dir,
    trustTier: report.trustTier,
    metrics,
    gates,
    generatedAt,
    harnessVersion: HARNESS_VERSION,
  });
  // 写入 evidence.json 与 evidence.lock，并把摘要打进 trace。
  const files = await writeEvidenceFiles(path.join(source.dir, 'evidence'), card);
  tracer.emit('evidence.written', {
    skill: card.skill,
    digest: files.digest,
    evidence: files.evidencePath,
  });

  if (options.json) {
    writeJson({ metrics, card, evidence: files, trace: tracer.events() });
    return EXIT.ok;
  }

  // 人类可读摘要：五项指标 + 已知失败 + 证据路径。
  console.log(`${card.skill}@${card.version}  n=${metrics.n}  k=${options.k}`);
  console.log(`pass@1: ${(metrics['pass@1'] * 100).toFixed(1)}% (95% CI ${(metrics.passAt1Ci95[0] * 100).toFixed(1)}%–${(metrics.passAt1Ci95[1] * 100).toFixed(1)}%)`);
  console.log(`pass^k: ${(metrics['pass^k'] * 100).toFixed(1)}%`);
  console.log(`cost_per_success: $${metrics.costPerSuccess.toFixed(6)}`);
  console.log(`p95_latency: ${metrics.p95LatencyMs}ms`);
  console.log(`escalation_rate: ${(metrics.escalationRate * 100).toFixed(1)}%`);
  if (metrics.knownFailures.length > 0) {
    console.log(`known_failures: ${metrics.knownFailures.join(', ')}`);
  }
  console.log(`evidence: ${files.evidencePath}`);
  console.log(`lock: ${files.lockPath} (${files.digest})`);
  return EXIT.ok;
}
