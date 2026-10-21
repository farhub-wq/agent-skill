/**
 * 准入发现项（finding）与门禁结果的数据结构。
 * 发现码是固定集合，便于 CI、issue 和文档稳定引用；
 * advisory 只是建议，不参与放行判定。
 */
/** 固定发现码集合，新增码需要同步更新文档与测试。 */
export const FINDING_CODES = [
  'preprocessing-command', // SKILL.md 中存在宿主预处理命令 !`command`
  'undeclared-tool', // 使用了未在清单中声明的工具族或权限
  'unlisted-script', // 脚本未在 permissions.exec 中登记
  'path-escape', // 路径逃出技能目录
  'network-egress', // 未声明的网络访问
  'dependency-risk', // 依赖范围无效、过宽或沙箱试跑失败
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];
export type FindingSeverity = 'error' | 'warning';

/** 一条准入发现；severity=error 会直接导致 deny。 */
export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  /** 人类可读的说明，包含触发位置等上下文。 */
  message: string;
  /** 触发问题的文件路径。 */
  path?: string;
  /** 最小化证据片段，避免把敏感原文带进报告。 */
  evidence?: string;
}

/** 建议项：只提示改进方向，永远不阻止准入，也不属于固定发现码。 */
export interface Advisory {
  id: string;
  message: string;
  path?: string;
}

/** 四道准入门的编号。 */
export type GateName = 'G1' | 'G2' | 'G3' | 'G4';

/** 单道门的执行结果，包含耗时，便于定位慢门禁。 */
export interface GateOutcome {
  gate: GateName;
  status: 'pass' | 'fail' | 'skipped';
  findings: Finding[];
  advisories: Advisory[];
  durationMs: number;
}

/** 构造发现项；默认 error，可通过 extra.severity 降级为 warning。 */
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

/** 按 code/path/evidence/message 去重，避免多道门重复报告同一问题。 */
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

/** 排序规则：error 在前，再按 code、path、message 字典序，保证输出稳定。 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    [a.severity === 'error' ? 0 : 1, a.code, a.path ?? '', a.message]
      .join('|')
      .localeCompare([b.severity === 'error' ? 0 : 1, b.code, b.path ?? '', b.message].join('|')),
  );
}
