/**
 * 清单 schema：定义 `skill.yaml` 与 `SKILL.md` frontmatter 的结构。
 * 双文件清单的设计意图：frontmatter 只放模型发现所需字段，
 * 运行时元数据放在 `skill.yaml`，避免模型误读权限声明。
 */
import { z } from 'zod';

/** 信任等级从低到高排列，运行时权限上限由等级决定。 */
export const TRUST_LEVELS = ['community', 'reviewed', 'vendor', 'certified'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** 数据敏感级别：PII 与密钥，DLP 与权限上限都会引用。 */
export const DATA_CLASSES = ['pii', 'secrets'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** 权限声明：所有字段默认空数组，缺省即“不授予”。 */
export const PermissionsSchema = z.object({
  fs: z.array(z.string().min(1)).default([]),
  net: z.array(z.string().min(1)).default([]),
  exec: z.array(z.string().min(1)).default([]),
  data: z.array(z.enum(DATA_CLASSES)).default([]),
  irreversible: z.array(z.string().min(1)).default([]),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

/** 技能名必须是 kebab-case，便于作为注册表键与目录名。 */
const skillName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'skill name must be kebab-case: [a-z0-9][a-z0-9-]*');

/**
 * `skill.yaml` 的完整运行时清单。
 * `permissions` 缺省时统一补成空权限对象，后续代码无需再判空。
 */
export const SkillManifestSchema = z
  .object({
    name: skillName,
    version: z.string().min(1),
    capabilities: z.array(z.string().min(1)).min(1),
    requires: z.record(z.string(), z.string()).default({}),
    conflicts: z.array(z.string()).default([]),
    permissions: PermissionsSchema.optional(),
    trust: z.enum(TRUST_LEVELS).default('community'),
    eval: z.string().min(1).optional(),
  })
  .transform((value) => ({
    ...value,
    permissions: value.permissions ?? PermissionsSchema.parse({}),
  }));

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/**
 * `SKILL.md` frontmatter 刻意保持最小：只允许名称与描述。
 * 运行时元数据不进入模型上下文，避免模型把声明当成事实。
 */
export const SkillFrontmatterSchema = z.object({
  name: skillName,
  description: z.string().min(1).max(4000),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
