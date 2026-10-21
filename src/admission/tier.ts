/**
 * 信任等级与权限上限：把清单里的 trust 字段映射为 T1–T4，
 * 再按等级限定可声明的权限范围。G4 与运行时都依赖这张表。
 */
import type { DataClass, TrustLevel } from '../manifest/schema.js';

export type TrustTier = 'T1' | 'T2' | 'T3' | 'T4';

/** 某个信任等级允许的最大权限集合。 */
export interface PermissionCeiling {
  /** 是否允许执行声明的脚本。 */
  exec: boolean;
  /** 是否允许网络访问。 */
  net: boolean;
  /** 文件系统范围：只读技能目录 / 可写技能目录 / 可写声明路径。 */
  fs: 'skill-read' | 'skill-write' | 'declared-write';
  /** 允许触及的数据类。 */
  data: DataClass[];
  /** 是否允许不可逆操作。 */
  irreversible: boolean;
}

/** 信任级别到分级编号的映射。 */
const TIER_OF_TRUST: Record<TrustLevel, TrustTier> = {
  community: 'T1',
  reviewed: 'T2',
  vendor: 'T3',
  certified: 'T4',
};

/** 各等级上限：T1/T2 不能执行脚本或联网，T4 才可访问 secrets。 */
const CEILING: Record<TrustTier, PermissionCeiling> = {
  T1: { exec: false, net: false, fs: 'skill-read', data: [], irreversible: false },
  T2: { exec: false, net: false, fs: 'skill-write', data: [], irreversible: false },
  T3: { exec: true, net: true, fs: 'skill-write', data: ['pii'], irreversible: true },
  T4: { exec: true, net: true, fs: 'declared-write', data: ['pii', 'secrets'], irreversible: true },
};

/** 根据清单 trust 字段取得分级。 */
export function tierForTrust(trust: TrustLevel): TrustTier {
  return TIER_OF_TRUST[trust];
}

/** 返回等级上限的浅拷贝，防止调用方篡改内部常量。 */
export function permissionCeiling(tier: TrustTier): PermissionCeiling {
  return { ...CEILING[tier], data: [...CEILING[tier].data] };
}

/** 该等级是否允许脚本执行（运行时快速判断）。 */
export function isExecAllowed(tier: TrustTier): boolean {
  return CEILING[tier].exec;
}
