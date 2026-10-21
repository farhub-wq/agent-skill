/**
 * 单次运行的执行上下文：把技能、信任分级、权限上限和 tracer 显式携带，
 * 避免代码里出现隐式的“当前技能/当前会话”全局状态。
 */
import type { PermissionCeiling, TrustTier } from '../admission/tier.js';
import { permissionCeiling, tierForTrust } from '../admission/tier.js';
import type { RegisteredSkill } from '../registry/scope.js';
import type { Tracer } from '../trace/tracer.js';

/** 一次技能执行所需的全部上下文。 */
export interface RunContext {
  /** 本次运行的唯一标识，trace 与结果元数据都引用它。 */
  runId: string;
  /** 已注册技能（清单 + 目录 + 作用域）。 */
  skill: RegisteredSkill;
  /** 由 trust 推导出的分级。 */
  tier: TrustTier;
  /** 该分级允许的权限上限。 */
  ceiling: PermissionCeiling;
  /** 本次运行的事件记录器。 */
  tracer: Tracer;
}

/**
 * 创建运行上下文。
 * 每一步执行都显式携带上下文；代码库中不存在隐式的“当前技能”或“当前会话”。
 */
export function createRunContext(input: {
  skill: RegisteredSkill;
  tracer: Tracer;
  runId?: string;
}): RunContext {
  // 分级完全由清单 trust 推导，调用方无法自定义。
  const tier = tierForTrust(input.skill.manifest.trust);
  return {
    // 未显式给 runId 时复用 tracer 的 runId，保证事件与结果同源。
    runId: input.runId ?? input.tracer.runId,
    skill: input.skill,
    tier,
    ceiling: permissionCeiling(tier),
    tracer: input.tracer,
  };
}
