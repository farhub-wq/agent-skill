import type { PermissionCeiling, TrustTier } from '../admission/tier.js';
import { permissionCeiling, tierForTrust } from '../admission/tier.js';
import type { RegisteredSkill } from '../registry/scope.js';
import type { Tracer } from '../trace/tracer.js';

export interface RunContext {
  runId: string;
  skill: RegisteredSkill;
  tier: TrustTier;
  ceiling: PermissionCeiling;
  tracer: Tracer;
}

/**
 * Every execution carries its context explicitly. There is no ambient
 * "current skill" or "current session" anywhere in the codebase.
 */
export function createRunContext(input: {
  skill: RegisteredSkill;
  tracer: Tracer;
  runId?: string;
}): RunContext {
  const tier = tierForTrust(input.skill.manifest.trust);
  return {
    runId: input.runId ?? input.tracer.runId,
    skill: input.skill,
    tier,
    ceiling: permissionCeiling(tier),
    tracer: input.tracer,
  };
}
