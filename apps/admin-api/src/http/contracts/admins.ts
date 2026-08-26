/**
 * 管理员管理契约（动态 RBAC——docs/admin-rbac-dynamic;角色经 roleId FK,词表在 roles 表）。
 * 密码强度策略单源在 identity（credentials.register 内校验,契约层不重复）。
 */
import * as z from 'zod';

export const adminsContracts = {
  /** 创建：email + 初始密码 + 角色 FK（邀请制语义——初始密码由超管线下传递） */
  create: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    displayName: z.string().trim().min(1).max(64).optional(),
    password: z.string().min(1).max(256),
    roleId: z.number().int().min(1),
  }),
  /** 部分更新：displayName 可改自身;roleId/status 不可改自身（D6,路由层守卫） */
  patch: z
    .object({
      displayName: z.string().trim().min(1).max(64).nullable().optional(),
      roleId: z.number().int().min(1).optional(),
      status: z
        .number()
        .int()
        .refine((value) => value === 0 || value === 1 || value === 2, {
          message: 'status must be 0 (active), 1 (banned) or 2 (retired)',
        })
        .optional(),
    })
    .refine(
      (body) =>
        body.displayName !== undefined || body.roleId !== undefined || body.status !== undefined,
      { message: 'at least one of displayName, roleId, status is required' },
    ),
} as const;
