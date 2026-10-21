export interface AttemptMetrics {
  pass: boolean;
  costUsd: number;
  latencyMs: number;
  escalated: boolean;
}

export interface CaseOutcome {
  caseId: string;
  attempts: AttemptMetrics[];
}

export interface EvalMetrics {
  n: number;
  totalAttempts: number;
  successes: number;
  'pass@1': number;
  passAt1Ci95: [number, number];
  'pass^k': number;
  costPerSuccess: number;
  p95LatencyMs: number;
  escalationRate: number;
  knownFailures: string[];
}

/** Wilson score interval, 95%. */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): [number, number] {
  if (n === 0) return [0, 0];
  const phat = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (centre - margin) / denominator),
    Math.min(1, (centre + margin) / denominator),
  ];
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function computeMetrics(cases: readonly CaseOutcome[]): EvalMetrics {
  const attempts = cases.flatMap((entry) => entry.attempts);
  const totalAttempts = attempts.length;
  const successes = attempts.filter((attempt) => attempt.pass).length;
  const allPassCases = cases.filter(
    (entry) => entry.attempts.length > 0 && entry.attempts.every((attempt) => attempt.pass),
  ).length;
  const totalCost = attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
  const escalated = attempts.filter((attempt) => attempt.escalated).length;
  const latencies = attempts.map((attempt) => attempt.latencyMs);

  return {
    n: cases.length,
    totalAttempts,
    successes,
    'pass@1': totalAttempts === 0 ? 0 : successes / totalAttempts,
    passAt1Ci95: wilsonInterval(successes, totalAttempts),
    'pass^k': cases.length === 0 ? 0 : allPassCases / cases.length,
    costPerSuccess: successes === 0 ? 0 : totalCost / successes,
    p95LatencyMs: percentile(latencies, 0.95),
    escalationRate: totalAttempts === 0 ? 0 : escalated / totalAttempts,
    knownFailures: cases
      .filter((entry) => entry.attempts.some((attempt) => !attempt.pass))
      .map((entry) => entry.caseId)
      .sort(),
  };
}
