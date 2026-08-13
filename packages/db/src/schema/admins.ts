import { pgTable, bigserial, varchar, smallint, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
    /** 0 正常 / 1 封禁 / 2 注销 */
    status: smallint('status').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admins_email_uq').on(t.email)],
);
