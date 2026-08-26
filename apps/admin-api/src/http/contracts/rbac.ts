/**
 * 动态 RBAC 契约（roles/permissions 管理面——ADR-0008;docs/admin-rbac-dynamic/DESIGN §5）。
 * 码形状/守卫在 control-plane 用例;此处只锁 wire 形状。
 */
import * as z from 'zod';

export const rbacContracts = {
  createRole: z.object({
    code: z.string().trim().min(2).max(64),
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(512).nullable().optional(),
    permissions: z.array(z.string().min(3).max(64)).max(100),
  }),
  patchRole: z
    .object({
      name: z.string().trim().min(1).max(128).optional(),
      description: z.string().trim().max(512).nullable().optional(),
      status: z
        .number()
        .int()
        .refine((v) => v === 0 || v === 1)
        .optional(),
      /** 授权全量替换（LWW;未传不动） */
      permissions: z.array(z.string().min(3).max(64)).max(100).optional(),
    })
    .refine(
      (b) =>
        b.name !== undefined ||
        b.description !== undefined ||
        b.status !== undefined ||
        b.permissions !== undefined,
      {
        message: 'at least one field is required',
      },
    ),
  createPermission: z.object({
    parentId: z.number().int().min(1).nullable(),
    type: z.enum(['group', 'page', 'button']),
    code: z.string().trim().max(64).nullable().optional(),
    name: z.string().trim().min(1).max(128),
    i18nKey: z.string().trim().max(128).nullable().optional(),
    description: z.string().trim().max(512).nullable().optional(),
    path: z.string().trim().max(255).nullable().optional(),
    icon: z.string().trim().max(64).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999),
  }),
  patchPermission: z
    .object({
      name: z.string().trim().min(1).max(128).optional(),
      i18nKey: z.string().trim().max(128).nullable().optional(),
      description: z.string().trim().max(512).nullable().optional(),
      icon: z.string().trim().max(64).nullable().optional(),
      path: z.string().trim().max(255).nullable().optional(),
      sortOrder: z.number().int().min(0).max(9999).optional(),
      status: z
        .number()
        .int()
        .refine((v) => v === 0 || v === 1)
        .optional(),
      code: z.string().trim().max(64).nullable().optional(),
      type: z.enum(['group', 'page', 'button']).optional(),
      parentId: z.number().int().min(1).nullable().optional(),
      source: z.enum(['enforced', 'custom']).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' }),
} as const;
