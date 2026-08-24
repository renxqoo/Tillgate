import {
  boolean,
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ACCOUNT_STATUS } from './account-status.js';
import { roles } from './rbac.js';

/**
 * admins — 管理员账户（与 users 物理隔离）。
 *
 * 管理员只持有「后台操作身份」，不持有任何用户业务数据（余额/费率卡/凭证/调用记录）。
 * 这是「严格互斥」设计：一个人要既用网关（充值/调 API）又管后台，需要两个账号、两次登录。
 *
 * 身份：仅本地账号（email + scrypt 密码），邀请制创建，不支持 OIDC。
 *      2FA 字段预留（twoFactorSecret），P1 启用强制两步验证。
 *
 * audit_logs.admin_id → admins.id（管理员操作审计的操作人）。
 */
export const admins = pgTable(
  'admins',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 登录账号（唯一，邀请制分配） */
    email: varchar('email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 64 }),
    /** scrypt 哈希，格式与 users.password_hash 一致（saltHex:hashHex:N:r:p） */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    /** 2FA 密钥（TOTP base32）；NULL = 未启用 2FA（P1 将要求非空） */
    twoFactorSecret: varchar('two_factor_secret', { length: 64 }),
    /** 账号状态：ACCOUNT_STATUS（0 正常 / 1 封禁 / 2 注销）；CHECK admins_status_ck 兜底非法值 */
    status: smallint('status').notNull().default(ACCOUNT_STATUS.ACTIVE),
    /**
     * 动态 RBAC（ADR-0008）：角色 FK（roles 表,0082 迁移切换 + 回填 NOT NULL）。
     * 旧 role varchar 列在 v2-3 消费者改造完成后由 0083 drop（波次内两步迁移,
     * 每步门禁可绿;非对外兼容层）。
     */
    roleId: bigint('role_id', { mode: 'number' })
      .notNull()
      .references(() => roles.id),
    /** 邮箱验证码二次登录开关（默认关；开启后登录需邮箱收码验证。SMTP 未配置时开启失败） */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    /** 会话失效线（R5-2）：iat 早于此时间点的管理面会话 JWT 一律拒绝（改密即全网下线） */
    sessionInvalidBefore: timestamp('session_invalid_before', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admins_email_uq').on(t.email),
    // 集合与 ACCOUNT_STATUS 一致（新增状态须同步常量与本约束）
    check('admins_status_ck', sql`${t.status} in (0, 1, 2)`),
    // admins_role_ck 随 role varchar 列在 0083 一并 drop（切换期 DB 仍持有旧约束）
  ],
);
