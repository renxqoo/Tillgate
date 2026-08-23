/**
 * 管理员管理契约（RBAC admins 域——super_admin 专属;docs/admin-rbac/DESIGN §2.5）。
 * 角色词表封闭（ADMIN_ROLES 单一真相 = control-plane domain/rbac）;
 * 密码强度策略单源在 identity（credentials.register 内校验,契约层不重复）。
 */
import { z } from 'zod';
import { ADMIN_ROLES } from '@tokenlens/control-plane';

export const adminsContracts = {
  /** 创建：email + 初始密码 + 角色（邀请制语义——初始密码由超管线下传递） */
  create: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    displayName: z.string().trim().min(1).max(64).optional(),
    password: z.string().min(1).max(256),
    role: z.enum(ADMIN_ROLES),
  }),
  /** 部分更新：displayName 可改自身;role/status 不可改自身（DESIGN D6,路由层守卫） */
  patch: z
    .object({
      displayName: z.string().trim().min(1).max(64).nullable().optional(),
      role: z.enum(ADMIN_ROLES).optional(),
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
        body.displayName !== undefined || body.role !== undefined || body.status !== undefined,
      { message: 'at least one of displayName, role, status is required' },
    ),
} as const;
