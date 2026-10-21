import type { DataClass, TrustLevel } from '../manifest/schema.js';

export type TrustTier = 'T1' | 'T2' | 'T3' | 'T4';

export interface PermissionCeiling {
  /** Whether the tier may run declared scripts at all. */
  exec: boolean;
  net: boolean;
  fs: 'skill-read' | 'skill-write' | 'declared-write';
  data: DataClass[];
  irreversible: boolean;
}

const TIER_OF_TRUST: Record<TrustLevel, TrustTier> = {
  community: 'T1',
  reviewed: 'T2',
  vendor: 'T3',
  certified: 'T4',
};

const CEILING: Record<TrustTier, PermissionCeiling> = {
  T1: { exec: false, net: false, fs: 'skill-read', data: [], irreversible: false },
  T2: { exec: false, net: false, fs: 'skill-write', data: [], irreversible: false },
  T3: { exec: true, net: true, fs: 'skill-write', data: ['pii'], irreversible: true },
  T4: { exec: true, net: true, fs: 'declared-write', data: ['pii', 'secrets'], irreversible: true },
};

export function tierForTrust(trust: TrustLevel): TrustTier {
  return TIER_OF_TRUST[trust];
}

export function permissionCeiling(tier: TrustTier): PermissionCeiling {
  return { ...CEILING[tier], data: [...CEILING[tier].data] };
}

export function isExecAllowed(tier: TrustTier): boolean {
  return CEILING[tier].exec;
}
