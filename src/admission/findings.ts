export const FINDING_CODES = [
  'preprocessing-command',
  'undeclared-tool',
  'unlisted-script',
  'path-escape',
  'network-egress',
  'dependency-risk',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];
export type FindingSeverity = 'error' | 'warning';

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  path?: string;
  evidence?: string;
}

/** Advisory notes never block admission and are not part of the fixed code set. */
export interface Advisory {
  id: string;
  message: string;
  path?: string;
}

export type GateName = 'G1' | 'G2' | 'G3' | 'G4';

export interface GateOutcome {
  gate: GateName;
  status: 'pass' | 'fail' | 'skipped';
  findings: Finding[];
  advisories: Advisory[];
  durationMs: number;
}

export function finding(
  code: FindingCode,
  message: string,
  extra: Pick<Finding, 'path' | 'evidence'> & { severity?: FindingSeverity } = {},
): Finding {
  return {
    code,
    severity: extra.severity ?? 'error',
    message,
    ...(extra.path === undefined ? {} : { path: extra.path }),
    ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
  };
}

export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const item of findings) {
    const key = [item.code, item.path ?? '', item.evidence ?? '', item.message].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    [a.severity === 'error' ? 0 : 1, a.code, a.path ?? '', a.message]
      .join('|')
      .localeCompare([b.severity === 'error' ? 0 : 1, b.code, b.path ?? '', b.message].join('|')),
  );
}
