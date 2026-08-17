/**
 * 身份内核七表（业务无关，本包私有，不 FK 到消费方 users 表——userId 由消费方分配）：
 *
 *   identity_credentials      标识 ↔ userId（谁是谁）：UNIQUE(kind, value) = 一个标识一个账号
 *   identity_passwords        密码哈希（用户知道什么）：一人一行，与标识解耦
 *   identity_oauth_links      三方绑定：UNIQUE(provider, subject) 防劫持 + UNIQUE(user_id, provider)
 *   identity_challenges       统一挑战（登录码/注册验证/找回/短信）：码只存加盐哈希；
 *                             XOR 目标 CHECK + 部分唯一索引「同 kind 同目标至多一条活挑战」
 *   identity_totp             MFA 注册（pending→confirmed 在列上）+ 单调步进防重放
 *   identity_recovery_codes   恢复码（只存哈希，单次消费）
 *   identity_session_anchors  会话吊销锚点（每用户一行，GREATEST 单调推进）
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const identityCredentials = pgTable(
  'identity_credentials',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    identifierKind: varchar('identifier_kind', { length: 16 }).notNull(),
    identifierValue: varchar('identifier_value', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identity_credentials_identifier_uq').on(t.identifierKind, t.identifierValue),
    index('identity_credentials_user_idx').on(t.userId),
    check('identity_credentials_kind_ck', sql`${t.identifierKind} in ('email', 'phone', 'username')`),
  ],
);

export const identityPasswords = pgTable('identity_passwords', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const identityOauthLinks = pgTable(
  'identity_oauth_links',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identity_oauth_links_provider_subject_uq').on(t.provider, t.subject),
    uniqueIndex('identity_oauth_links_user_provider_uq').on(t.userId, t.provider),
    index('identity_oauth_links_user_idx').on(t.userId),
  ],
);

export const identityChallenges = pgTable(
  'identity_challenges',
  {
    id: uuid('id').primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(),
    identifierKind: varchar('identifier_kind', { length: 16 }),
    identifierValue: varchar('identifier_value', { length: 255 }),
    userId: bigint('user_id', { mode: 'number' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    payload: jsonb('payload'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    abortedAt: timestamp('aborted_at', { withTimezone: true }),
  },
  (t) => [
    // 目标二选一（标识或用户，恰一个非空）：结构上消灭「双空/双有」的歧义行
    check('identity_challenges_target_ck', sql`(${t.identifierValue} is null) <> (${t.userId} is null)`),
    check(
      'identity_challenges_target_kind_ck',
      sql`${t.identifierValue} is null or ${t.identifierKind} is not null`,
    ),
    // 错次上限随行快照；attempts 越过上限在结构上不可能
    check('identity_challenges_attempts_ck', sql`${t.attempts} between 0 and ${t.maxAttempts}`),
    check('identity_challenges_max_attempts_ck', sql`${t.maxAttempts} between 1 and 100`),
    check('identity_challenges_expiry_ck', sql`${t.expiresAt} > ${t.issuedAt}`),
    // 终态互斥：不可能既消费又作废
    check('identity_challenges_terminal_ck', sql`${t.consumedAt} is null or ${t.abortedAt} is null`),
    // 同 kind 同目标至多一条活挑战（发码防刷的结构闸；应用层冷却在其上做替换语义）
    uniqueIndex('identity_challenges_live_identifier_uq')
      .on(t.kind, t.identifierKind, t.identifierValue)
      .where(sql`consumed_at is null and aborted_at is null`),
    uniqueIndex('identity_challenges_live_user_uq')
      .on(t.kind, t.userId)
      .where(sql`consumed_at is null and aborted_at is null and user_id is not null`),
    index('identity_challenges_expires_idx').on(t.expiresAt),
  ],
);

export const identityTotp = pgTable('identity_totp', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  /** base32 密钥或 SecretCipher 密文 */
  secret: text('secret').notNull(),
  /** NULL = 挂起注册（enroll 未 confirm）；confirm 前不参与 MFA */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** 已消费的最大步号（单调；同码/旧码重放被 CAS 拒绝） */
  lastUsedStep: bigint('last_used_step', { mode: 'number' }).notNull().default(-1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const identityRecoveryCodes = pgTable(
  'identity_recovery_codes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identity_recovery_codes_hash_uq').on(t.userId, t.codeHash),
    index('identity_recovery_codes_user_idx').on(t.userId),
  ],
);

export const identitySessionAnchors = pgTable('identity_session_anchors', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  invalidBefore: timestamp('invalid_before', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const IDENTITY_DDL: readonly string[] = [
  `
    create table if not exists identity_credentials (
      id bigserial primary key,
      user_id bigint not null,
      identifier_kind varchar(16) not null,
      identifier_value varchar(255) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint identity_credentials_identifier_uq unique (identifier_kind, identifier_value),
      constraint identity_credentials_kind_ck check (identifier_kind in ('email', 'phone', 'username'))
    )`,
  `create index if not exists identity_credentials_user_idx on identity_credentials (user_id)`,
  `
    create table if not exists identity_passwords (
      user_id bigint primary key,
      password_hash varchar(255) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
  `
    create table if not exists identity_oauth_links (
      id bigserial primary key,
      user_id bigint not null,
      provider varchar(32) not null,
      subject varchar(255) not null,
      email varchar(255),
      linked_at timestamptz not null default now(),
      constraint identity_oauth_links_provider_subject_uq unique (provider, subject),
      constraint identity_oauth_links_user_provider_uq unique (user_id, provider)
    )`,
  `create index if not exists identity_oauth_links_user_idx on identity_oauth_links (user_id)`,
  `
    create table if not exists identity_challenges (
      id uuid primary key,
      kind varchar(32) not null,
      identifier_kind varchar(16),
      identifier_value varchar(255),
      user_id bigint,
      code_hash varchar(64) not null,
      payload jsonb,
      attempts integer not null default 0,
      max_attempts integer not null,
      issued_at timestamptz not null default now(),
      expires_at timestamptz not null,
      consumed_at timestamptz,
      aborted_at timestamptz,
      constraint identity_challenges_target_ck check ((identifier_value is null) <> (user_id is null)),
      constraint identity_challenges_target_kind_ck check (identifier_value is null or identifier_kind is not null),
      constraint identity_challenges_attempts_ck check (attempts between 0 and max_attempts),
      constraint identity_challenges_max_attempts_ck check (max_attempts between 1 and 100),
      constraint identity_challenges_expiry_ck check (expires_at > issued_at),
      constraint identity_challenges_terminal_ck check (consumed_at is null or aborted_at is null)
    )`,
  `
    create unique index if not exists identity_challenges_live_identifier_uq
      on identity_challenges (kind, identifier_kind, identifier_value)
      where consumed_at is null and aborted_at is null`,
  `
    create unique index if not exists identity_challenges_live_user_uq
      on identity_challenges (kind, user_id)
      where consumed_at is null and aborted_at is null and user_id is not null`,
  `create index if not exists identity_challenges_expires_idx on identity_challenges (expires_at)`,
  `
    create table if not exists identity_totp (
      user_id bigint primary key,
      secret text not null,
      confirmed_at timestamptz,
      last_used_step bigint not null default -1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
  `
    create table if not exists identity_recovery_codes (
      id bigserial primary key,
      user_id bigint not null,
      code_hash varchar(64) not null,
      used_at timestamptz,
      created_at timestamptz not null default now(),
      constraint identity_recovery_codes_hash_uq unique (user_id, code_hash)
    )`,
  `create index if not exists identity_recovery_codes_user_idx on identity_recovery_codes (user_id)`,
  `
    create table if not exists identity_session_anchors (
      user_id bigint primary key,
      invalid_before timestamptz not null,
      updated_at timestamptz not null default now()
    )`,
];

/** 一次性建齐七表（幂等；独立 schema/独立库均可） */
export async function provision(db: NodePgDatabase): Promise<void> {
  for (const statement of IDENTITY_DDL) {
    await db.execute(sql.raw(statement));
  }
}

/** DDL 导出（消费方自己的迁移管线收录用；与 provision 同源同序） */
export function provisionSql(): readonly string[] {
  return IDENTITY_DDL;
}

/** 测试清场：drop 七表（业务环境勿用） */
export async function deprovision(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`drop table if exists identity_credentials`);
  await db.execute(sql`drop table if exists identity_passwords`);
  await db.execute(sql`drop table if exists identity_oauth_links`);
  await db.execute(sql`drop table if exists identity_challenges`);
  await db.execute(sql`drop table if exists identity_totp`);
  await db.execute(sql`drop table if exists identity_recovery_codes`);
  await db.execute(sql`drop table if exists identity_session_anchors`);
}
