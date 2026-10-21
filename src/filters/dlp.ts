/**
 * DLP 过滤器：在工具调用进入处理器前扫描参数中的密钥与 PII。
 * 这是过滤链的第四道（order 40），遵循“先拦截、再执行”的顺序。
 */
import type { DataClass } from '../manifest/schema.js';
import { FilterPolicyError, type ToolFilter } from './chain.js';

/** 常见密钥形态：AWS、GitHub、OpenAI、私钥与 Bearer Token。 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
];

/** 轻量 PII 形态：邮箱与美式社会安全号；只用于拦截，不做完整识别。 */
export const PII_PATTERNS: readonly RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

export interface DlpOptions {
  /** 技能声明允许处理的数据类别；未声明的类别一律拒绝。 */
  allowedData: readonly DataClass[];
}

function detect(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * 创建 DLP 过滤器。
 * 错误信息只说明“检测到密钥/PII”，绝不回显匹配到的值：
 * DLP 事件本身不能变成它要阻止的那次泄露。
 */
export function createDlpFilter(options: DlpOptions): ToolFilter {
  return {
    name: 'dlp',
    order: 40,
    async before(call, next) {
      // 参数统一序列化后扫描，避免遗漏嵌套字段。
      const text = JSON.stringify(call.args);
      if (detect(SECRET_PATTERNS, text) && !options.allowedData.includes('secrets')) {
        throw new FilterPolicyError('DLP_SECRET_BLOCKED', 'arguments contain a secret and secrets are not allowed');
      }
      if (detect(PII_PATTERNS, text) && !options.allowedData.includes('pii')) {
        throw new FilterPolicyError('DLP_PII_BLOCKED', 'arguments contain PII and pii is not allowed');
      }
      return next();
    },
  };
}
