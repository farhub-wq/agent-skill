/**
 * 包入口：统一导出对外 API。
 * 按模块分组：admission 准入、adapter 适配、eval 评测、evidence 证据、
 * filters 过滤链、lifecycle 生命周期、manifest 清单、registry 注册、
 * runtime 运行时、trace 追踪。
 */
// 准入与分级
export { AdmissionDeniedError, assertAdmitted, runAdmission } from './admission/gate.js';
export type { AdmissionReport, GateMode } from './admission/gate.js';
export { FINDING_CODES } from './admission/findings.js';
export type { Advisory, Finding, FindingCode, GateOutcome } from './admission/findings.js';
export { permissionCeiling, tierForTrust } from './admission/tier.js';
export type { PermissionCeiling, TrustTier } from './admission/tier.js';
// 宿主适配器
export { createClaudeAdapter, ADAPTER_LIMITATION } from './adapter/claude.js';
export type { ClaudeAdapter, ClaudeHookPayload, ClaudeHookResult } from './adapter/claude.js';
// 评测与证据
export { buildEvidenceCard, hashSkillDir } from './eval/evidence.js';
export type { EvidenceCard } from './eval/evidence.js';
export { loadCases, parseEvalCase } from './eval/case.js';
export type { EvalCase } from './eval/case.js';
export { l0ExactGrader, l1FieldGrader, l2JudgeGrader } from './eval/grader.js';
export type { Grader, GraderResult } from './eval/grader.js';
export { computeMetrics, wilsonInterval } from './eval/metrics.js';
export type { EvalMetrics } from './eval/metrics.js';
export { createScriptTarget, runEval } from './eval/runner.js';
export type { EvalTarget, EvalTargetResult } from './eval/runner.js';
export { sha256Hex, verifyEvidenceLock, writeEvidenceFiles } from './evidence/lock.js';
// 过滤链
export { createDefaultFilters } from './filters/index.js';
export {
  createFilterChain,
  FilterPolicyError,
} from './filters/chain.js';
export type { FilterChain, Caller, SideEffect, ToolCall, ToolFilter, ToolResult } from './filters/chain.js';
// 生命周期与后处理
export { runPostProcessors } from './lifecycle/post-processor.js';
export type { PostProcessorContext, SkillPostProcessor } from './lifecycle/post-processor.js';
export { createLifecycle } from './lifecycle/skill.js';
export type { Lifecycle, LifecycleHook, LifecycleState } from './lifecycle/skill.js';
// 清单解析与校验
export { allowedToolsOf, loadSkillSource, parseManifest, parseSkillMarkdown } from './manifest/parse.js';
export type { SkillDocument, SkillSource } from './manifest/parse.js';
export { SkillManifestSchema, SkillFrontmatterSchema, TRUST_LEVELS } from './manifest/schema.js';
export type { Permissions, SkillManifest, TrustLevel } from './manifest/schema.js';
// 注册表
export { createRegistry, DependencyConflictError, toRegisteredSkill } from './registry/registry.js';
export type { Registry } from './registry/registry.js';
export { SCOPE_PRECEDENCE } from './registry/scope.js';
export type { RegisteredSkill, Scope } from './registry/scope.js';
// 运行时
export { createRunContext } from './runtime/context.js';
export type { RunContext } from './runtime/context.js';
export { classifyFailure, createExecutor, FAILURE_MAPPING } from './runtime/executor.js';
export type { Executor, FailureClass } from './runtime/executor.js';
export { DEFAULT_SANDBOX_LIMITS, runSandboxed, tokenizeCommand } from './runtime/sandbox.js';
export type { SandboxLimits, SandboxRequest, SandboxResult } from './runtime/sandbox.js';
export { createSupervisor } from './runtime/supervisor.js';
// 追踪与版本
export { createJsonlLedger, readLedger } from './trace/ledger.js';
export { createTracer } from './trace/tracer.js';
export type { Tracer } from './trace/tracer.js';
export type { TraceEvent, TraceEventType } from './trace/events.js';
export { HARNESS_VERSION, VALUE_STATEMENTS } from './version.js';
