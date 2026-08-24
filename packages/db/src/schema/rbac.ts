import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * RBAC v2（ADR-0008）：动态角色 + 单表权限树。
 *
 * permissions = 注册面 + 资源树同体：
 *   group（目录,无码,纯结构）→ page（页面,持 域:read 码 + path;dashboard 无码全员）
 *   → button（按钮,持动词码,挂 page 下）。source=enforced 为种子落库的锁死节点
 *   （展示字段可改,code/path/type/父子不可）,custom 为运营自建。
 *
 * roles.is_super：隐式全量（不存授权行）——新码自动免疫,杜绝改小超管锁死全站。
 * role_permissions 绑 id（FK 级联）;判定原语是 code（会话回查 join 出码集合）。
 */
export const permissions = pgTable(
  'permissions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    parentId: bigint('parent_id', { mode: 'number' }),
    /** group | page | button */
    type: varchar('type', { length: 16 }).notNull(),
    /** 判定原语（group 无码;page 除 dashboard 外必须有码;button 必须有码） */
    code: varchar('code', { length: 64 }),
    /** 显示名（custom 文案 / enforced 的 fallback） */
    name: varchar('name', { length: 128 }).notNull(),
    /** 内置节点翻译键（nav.* 等;custom 为 NULL 走 name） */
    i18nKey: varchar('i18n_key', { length: 128 }),
    description: varchar('description', { length: 512 }),
    /** page 专属：前端路由路径（管理 UI 前端白名单校验） */
    path: varchar('path', { length: 255 }),
    /** page 专属：lucide 图标名（前端注册表映射,未知名兜底） */
    icon: varchar('icon', { length: 64 }),
    sortOrder: bigint('sort_order', { mode: 'number' }).notNull().default(0),
    /** 0 正常 / 1 停用（停用 = 该码 kill-switch,下一请求失效;enforced 不可停用） */
    status: smallint('status').notNull().default(0),
    /** enforced（种子,语义锁死）| custom（自由 CRUD） */
    source: varchar('source', { length: 16 }).notNull().default('custom'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('permissions_code_uq')
      .on(t.code)
      .where(sql`type = 'button'`),
    index('permissions_parent_idx').on(t.parentId),
    check('permissions_type_ck', sql`${t.type} in ('group', 'page', 'button')`),
    check('permissions_code_shape_ck', sql`(
      (type = 'group' and code is null) or
      (type = 'button' and code is not null) or
      type = 'page'
    )`),
    check('permissions_status_ck', sql`${t.status} in (0, 1)`),
    check('permissions_source_ck', sql`${t.source} in ('enforced', 'custom')`),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: varchar('description', { length: 512 }),
    /** 0 正常 / 1 停用（整角色 kill-switch——名下管理员下一请求零授权） */
    status: smallint('status').notNull().default(0),
    /** 隐式全量:无授权行,can() 短路;不可编辑/删除/停用 */
    isSuper: boolean('is_super').notNull().default(false),
    /** 5 个预置角色:不可删（可改授权/停用）;super 由此 + isSuper 双锁 */
    isBuiltin: boolean('is_builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_code_uq').on(t.code),
    check('roles_status_ck', sql`${t.status} in (0, 1)`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: bigint('role_id', { mode: 'number' }).notNull(),
    permissionId: bigint('permission_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index('role_permissions_permission_idx').on(t.permissionId),
  ],
);
