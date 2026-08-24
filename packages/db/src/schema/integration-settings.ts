import { check, bigint, boolean, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * integration_settings — 第三方集成动态配置（docs/integration-settings/DESIGN.md §3.1）。
 *
 * OAuth/SMTP/Turnstile/易支付/Stripe 凭据从 env 装配期注入迁入本表：
 * - secret 字段以 enc:v1 密文内嵌 config jsonb（根密钥与渠道 Key 同一部署契约）；
 * - previous_secrets 承载支付验签密钥轮换双读窗（96h 自愈，仅 rotatable 字段进入）；
 * - enabled=false 停用功能面但保留凭据（重新启用无需重录）。
 * key 词表封闭：单一真相在 control-plane domain（integration 域词表），本表 CHECK
 * 与之逐项相等（契约测试锁定）；无行 = 未配置（enabled=false, config={}）。
 */
export const integrationSettings = pgTable(
  'integration_settings',
  {
    /** 集成键（封闭词表：oauth.base/oauth.github/oauth.google/smtp/captcha.turnstile/payment.epay/payment.stripe） */
    key: varchar('key', { length: 64 }).primaryKey(),
    /** 功能面开关（true ⇒ config 必填齐全——写入侧用例保证） */
    enabled: boolean('enabled').notNull().default(false),
    /** 字段值（secret 字段为 enc:v1 密文；非 secret 明文） */
    config: jsonb('config').notNull().default({}),
    /** 轮换双读窗：{field: enc:v1 密文}——仅 payment 验签字段 */
    previousSecrets: jsonb('previous_secrets'),
    /** 最近一次 rotatable secret 轮换时刻 */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    updatedByAdminId: bigint('updated_by_admin_id', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'integration_settings_key_ck',
      sql`${t.key} IN ('oauth.base','oauth.github','oauth.google','smtp','captcha.turnstile','payment.epay','payment.stripe')`,
    ),
  ],
);
