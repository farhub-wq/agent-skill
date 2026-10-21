import { z } from 'zod';

export const TRUST_LEVELS = ['community', 'reviewed', 'vendor', 'certified'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const DATA_CLASSES = ['pii', 'secrets'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const PermissionsSchema = z.object({
  fs: z.array(z.string().min(1)).default([]),
  net: z.array(z.string().min(1)).default([]),
  exec: z.array(z.string().min(1)).default([]),
  data: z.array(z.enum(DATA_CLASSES)).default([]),
  irreversible: z.array(z.string().min(1)).default([]),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

const skillName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'skill name must be kebab-case: [a-z0-9][a-z0-9-]*');

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
 * SKILL.md frontmatter is deliberately narrow: only discovery fields belong
 * there. Runtime metadata lives in skill.yaml, so the model never consumes it.
 */
export const SkillFrontmatterSchema = z.object({
  name: skillName,
  description: z.string().min(1).max(4000),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
