/**
 * 真实 PostgreSQL 集成(IMPLEMENTATION §4 real 门):postgres 适配器的 SQL 语义
 * 只能以真实 PG 验证(§5.6 本地可替代依赖)——唯一冲突翻译、CAS 竞态单赢家、
 * FOR UPDATE 席位串行化、onConflictDoUpdate 复活、clock_timestamp 写入、
 * ilike 转义、审计同事务落库。
 *
 * 运行约定:DB_TEST_URL(优先)或 DATABASE_URL 缺失时整组 skip(铁律 14,与 db 包同约定)。
 * 目标库必须是专用测试库(本文件重建 schema 并 truncate)。
 * schema 建法:账号域 DDL fixture(与 packages/db schema 定义同拍维护)——
 * 迁移链暂不能从空库装起(依赖 identity-core/wallet/ledger 的 provision 链先建外部表,
 * 总纲 §9 P0 已在案;「空库升级」归 P3 收口,届时本 fixture 可退役)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  apiKeys,
  apps,
  auditLogs,
  closeDb,
  createDb,
  marketingSettings,
  orgInvitations,
  orgMembers,
  organizations,
  plans,
  rateCards,
  referrals,
  userSubscriptions,
  users,
  type Db,
} from '@tillgate/db';
import { createAccounts } from '../src/index.js';
import { V1_POLICY, type TestHarness } from '../src/testing/harness.js';
import { createTestHarness } from '../src/testing/harness.js';
import { sha256Hex } from '../src/domain/credentials.js';
import Decimal from 'decimal.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

/** 账号域 DDL fixture(镜像 packages/db/src/schema 的账号相关表;专用测试库专用) */
const ACCOUNTS_DDL = `
create table admins (id bigserial primary key, status smallint not null default 0);
create table rate_cards (id bigserial primary key, name varchar(32) not null, status smallint not null default 0);
create table users (
  id bigserial primary key,
  issuer varchar(64) not null, subject varchar(255) not null, identity_provider varchar(16) not null,
  email varchar(255), display_name varchar(64), rate_card_id bigint references rate_cards(id),
  daily_spend_limit numeric(38,18), status smallint not null default 0,
  session_invalid_before timestamptz, is_enterprise boolean not null default false,
  freeze_reason varchar(128), rpm_limit bigint, tpm_limit bigint, password_hash varchar(255),
  last_login_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint users_issuer_subject_uq unique (issuer, subject),
  constraint users_status_ck check (status in (0,1,2))
);
create unique index users_local_email_uq on users (email) where issuer = 'local' and email is not null;
create table organizations (
  id bigserial primary key, name varchar(64) not null, owner_user_id bigint not null references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table org_members (
  id bigserial primary key, org_id bigint not null references organizations(id), user_id bigint not null references users(id),
  role varchar(16) not null default 'member', status smallint not null default 0,
  daily_spend_limit numeric(38,18), monthly_quota numeric(38,18),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint org_members_org_user_uq unique (org_id, user_id)
);
create table org_invitations (
  id bigserial primary key, org_id bigint not null references organizations(id), email varchar(255) not null,
  token varchar(64) not null, invited_by_user_id bigint references users(id), status smallint not null default 0,
  expires_at timestamptz not null, accepted_by_user_id bigint references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint org_invitations_token_uq unique (token)
);
create table plans (
  id bigserial primary key, name varchar(32) not null, kind varchar(16) not null default 'subscription',
  sort_order bigint, price numeric(38,18) not null, period_days bigint not null, quota_amount numeric(38,18) not null,
  allow_seats boolean not null default false, status smallint not null default 0
);
create table user_subscriptions (
  id bigserial primary key, user_id bigint not null references users(id), plan_id bigint not null references plans(id),
  start_at timestamptz not null, end_at timestamptz not null, quota_amount numeric(38,18) not null,
  used_amount numeric(38,18) not null default '0', reserved_amount numeric(38,18) not null default '0',
  quantity bigint not null default 1, org_id bigint references organizations(id), price numeric(38,18) not null default '0',
  status smallint not null default 0, created_at timestamptz not null default now()
);
create unique index user_subscriptions_one_active_uq on user_subscriptions (user_id) where status = 0;
create unique index user_subscriptions_one_org_uq on user_subscriptions (org_id) where status = 0 and org_id is not null;
create table apps (
  id bigserial primary key, app_id varchar(32) not null, user_id bigint not null references users(id),
  client_id varchar(64) not null, client_secret_hash varchar(64) not null, name varchar(64) not null,
  description varchar(255), subscription_id bigint references user_subscriptions(id), scope jsonb,
  status smallint not null default 0, created_at timestamptz not null default now(), rotated_at timestamptz,
  constraint apps_app_id_uq unique (app_id), constraint apps_client_id_uq unique (client_id)
);
create table api_keys (
  id bigserial primary key, key_hash varchar(64) not null, key_preview varchar(40) not null,
  user_id bigint not null references users(id), app_id bigint references apps(id),
  subscription_id bigint references user_subscriptions(id), name varchar(64) not null, remark varchar(255),
  expires_at timestamptz, rpm_limit bigint, tpm_limit bigint, daily_spend_limit numeric(38,18),
  allow_payg_fallback boolean not null default false, status smallint not null default 0,
  last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now(),
  constraint api_keys_key_hash_uq unique (key_hash)
);
create table referrals (
  id bigserial primary key, inviter_user_id bigint not null references users(id),
  invitee_user_id bigint not null references users(id), status smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint referrals_invitee_uq unique (invitee_user_id),
  constraint referrals_self_invite_ck check (inviter_user_id <> invitee_user_id),
  constraint referrals_status_ck check (status in (0,1))
);
create table marketing_settings (
  id integer primary key default 1, signup_gift_amount numeric(38,18) not null default '0',
  referral_signup_bonus numeric(38,18) not null default '0', referral_commission_rate numeric(38,18) not null default '0',
  updated_by bigint references admins(id), updated_at timestamptz not null default now()
);
create table audit_logs (
  id bigserial primary key, admin_id bigint references admins(id) on delete set null,
  actor varchar(8) not null default 'admin', action varchar(64) not null, target_type varchar(32) not null,
  target_id varchar(64), detail jsonb, created_at timestamptz not null default now()
);
`;

/** 生成与内存替身一致口径的 policy/时钟(harness 仅提供替身与断言工具) */
function realHarness(db: Db): TestHarness {
  const h = createTestHarness();
  const api = createAccounts({
    db,
    walletCredit: h.wallet,
    sessionInvalidation: h.sessionInvalidation,
    policy: V1_POLICY,
    txRetry: { maxAttempts: 3, baseDelayMs: 5, maxJitterMs: 5 },
    now: h.ctx.now,
  });
  return Object.assign(h, { api });
}

(url ? describe : describe.skip)('postgres 适配器(真实 PG)', () => {
  let db: Db;
  let h: TestHarness;
  const api = () => h.api;

  async function seedTeam(quantity: number) {
    const owner = await api().provisionLocalAccount({
      email: `owner-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const org = await api().createOrg({ ownerUserId: owner.id, name: 'T' });
    const planRows = await db
      .insert(plans)
      .values({
        name: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        price: '1',
        periodDays: 30,
        quotaAmount: '1000',
        allowSeats: true,
      })
      .returning({ id: plans.id });
    const plan = planRows[0]!;
    await db.insert(userSubscriptions).values({
      userId: owner.id,
      planId: plan.id,
      startAt: sql`clock_timestamp() - interval '1 hour'`,
      endAt: sql`clock_timestamp() + interval '30 days'`,
      quotaAmount: '1000',
      quantity,
      orgId: org.id,
      price: '1',
    });
    return { owner, org };
  }

  beforeAll(async () => {
    db = createDb({
      url: url!,
      poolMax: 8,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 10_000,
    });
    // 专用测试库:重建 public schema 后装账号域 fixture
    await db.execute(sql`drop schema public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql.raw(ACCOUNTS_DDL));
    // 审计/营销参数的 adminId 外键目标(fixture 管理员 1..99)
    await db.execute(sql`insert into admins (id) select generate_series(1, 99)`);
    h = realHarness(db);
  });

  afterAll(async () => {
    if (db) {
      await db.execute(
        sql`truncate table ${users}, ${organizations}, ${orgMembers}, ${orgInvitations}, ${apiKeys}, ${apps}, ${referrals}, ${marketingSettings}, ${auditLogs}, ${userSubscriptions}, ${plans}, ${rateCards} cascade`,
      );
      await closeDb(db);
    }
  });

  it('本地建号:真实唯一冲突 → email_taken(23505 语义化,并发单赢家)', async () => {
    const email = `race-${Math.random().toString(36).slice(2)}@x.io`;
    const [a, b] = await Promise.allSettled([
      api().provisionLocalAccount({ email }),
      api().provisionLocalAccount({ email }),
    ]);
    const codes = [a, b].map((r) => (r.status === 'fulfilled' ? 'created' : r.reason.code));
    expect(codes.filter((c) => c === 'created')).toHaveLength(1);
    expect(codes.filter((c) => c === 'accounts.email_taken')).toHaveLength(1);
  });

  it('管理补丁:封禁缺省原因 + 审计同事务落库 audit_logs + DB 时钟推进 updatedAt(B4/B6)', async () => {
    const u = await api().provisionLocalAccount({
      email: `audit-${Math.random().toString(36).slice(2)}@x.io`,
    });
    await new Promise((r) => setTimeout(r, 5)); // 让 updatedAt 有可分辨的时差
    const banned = await api().adminPatchUser({ userId: u.id, patch: { status: 1 }, adminId: 42 });
    expect(banned.freezeReason).toBe('管理员封禁');
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, String(u.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'admin',
      adminId: 42,
      action: 'user.update',
      targetType: 'user',
    });
    expect(banned.updatedAt.getTime()).toBeGreaterThan(u.updatedAt.getTime()); // 存储时钟生效
  });

  it('email 变更:users 行更新 + 会话失效 port 同事务调用(§3.4;不再直写本表列)', async () => {
    const u = await api().provisionLocalAccount({
      email: `anchor-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const updated = await api().adminPatchUser({
      userId: u.id,
      patch: { email: `new-${Math.random().toString(36).slice(2)}@x.io` },
      adminId: 1,
    });
    // 列冻结只读(恒 null);吊销事实由 identity anchors 持有,port 调用已被 harness 记录
    expect(updated.sessionInvalidBefore).toBeNull();
    expect(h.sessionInvalidation.calls).toEqual([{ realm: 'user', userId: u.id }]);
  });

  it('Key 生命周期:创建→resolve 命中;吊销→即刻 miss;轮换→旧 miss 新命中(同事务两行)', async () => {
    const u = await api().provisionLocalAccount({
      email: `key-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const created = await api().createKey({ userId: u.id, name: 'k', rpmLimit: 7 });
    expect((await api().resolveKeyByHash(sha256Hex(created.plaintext)))!.rpmLimit).toBe(7);

    const rotated = await api().rotateKey({ userId: u.id, keyId: created.key.id });
    expect(await api().resolveKeyByHash(sha256Hex(created.plaintext))).toBeNull();
    expect((await api().resolveKeyByHash(sha256Hex(rotated.plaintext)))!.keyId).toBe(
      rotated.key.id,
    );
    // 两行并存:旧行 status=1 + revokedAt
    const oldRow = await db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
    expect(oldRow[0]!.status).toBe(1);
    expect(oldRow[0]!.revokedAt).not.toBeNull();
  });

  it('席位串行化:quantity=2(owner 占 1)两个并发接受恰好一个成功(FOR UPDATE 复检)', async () => {
    const { owner, org } = await seedTeam(2);
    const m1 = await api().provisionLocalAccount({
      email: `m1-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const m2 = await api().provisionLocalAccount({
      email: `m2-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const i1 = await api().inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: m1.email!,
    });
    const i2 = await api().inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: m2.email!,
    });

    const [r1, r2] = await Promise.allSettled([
      api().acceptInvitation({ token: i1.token, acceptorUserId: m1.id }),
      api().acceptInvitation({ token: i2.token, acceptorUserId: m2.id }),
    ]);
    const outcomes = [r1, r2].map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'accounts.seats_full')).toHaveLength(1);
    // 失败方的成员行随事务回滚不存在
    const members = await db.select().from(orgMembers).where(eq(orgMembers.orgId, org.id));
    expect(members.filter((m) => m.status === 0)).toHaveLength(2); // owner + 赢家
  });

  it('复活语义:移除成员 → 新邀请接受后同 (org,user) 行 status 回 0', async () => {
    const { owner, org } = await seedTeam(5);
    const m = await api().provisionLocalAccount({
      email: `revive-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const inv1 = await api().inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: m.email!,
    });
    await api().acceptInvitation({ token: inv1.token, acceptorUserId: m.id });
    await api().removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: m.id });

    const inv2 = await api().inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: m.email!,
    });
    await api().acceptInvitation({ token: inv2.token, acceptorUserId: m.id });
    const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, org.id));
    const mine = rows.filter((r) => r.userId === m.id);
    expect(mine).toHaveLength(1); // 未新增行
    expect(mine[0]!.status).toBe(0); // 复活
  });

  it('ilike 转义:q="100%" 只命中字面含 100% 的行,不通配匹配一切', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    await api().provisionLocalAccount({ email: `pct-a-${suffix}@x.io` }); // displayName 兜底 = 本地部分
    const literal = await db
      .update(users)
      .set({ displayName: `100%-${suffix}` })
      .where(eq(users.email, `pct-a-${suffix}@x.io`))
      .returning({ id: users.id });
    await api().provisionLocalAccount({ email: `pct-b-${suffix}@x.io` });
    const result = await api().adminListUsers({ q: `100%-${suffix}` });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.id).toBe(literal[0]!.id);
  });

  it('营销参数 upsert 单往返(B7):部分更新保留其余字段并返回全量', async () => {
    await api().updateMarketingSettings({ patch: { signupGiftAmount: '3.5' }, adminId: 7 });
    const second = await api().updateMarketingSettings({
      patch: { referralCommissionRate: '0.15' },
      adminId: 8,
    });
    // PG numeric(38,18) 定标尾零——金额断言用 Decimal 等值(v1 测试规约)
    expect(new Decimal(second.signupGiftAmount).eq('3.5')).toBe(true);
    expect(new Decimal(second.referralCommissionRate).eq('0.15')).toBe(true);
    expect(second.updatedBy).toBe(8);
    const rows = await db.select().from(marketingSettings);
    expect(rows).toHaveLength(1); // 单行表
  });

  it('App 凭证:创建/轮换(FOR UPDATE 行锁路径)与 client 双等值校验', async () => {
    const u = await api().provisionLocalAccount({
      email: `app-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const created = await api().createApp({ userId: u.id, name: 'a', scope: { rpm: 5 } });
    expect(
      (await api().verifyAppClient({
        clientId: created.app.clientId,
        clientSecret: created.clientSecret,
      }))!.appId,
    ).toBe(created.app.appId);
    const rotated = await api().rotateAppSecret({ userId: u.id, appId: created.app.id });
    expect(
      await api().verifyAppClient({
        clientId: created.app.clientId,
        clientSecret: created.clientSecret,
      }),
    ).toBeNull();
    expect(
      (await api().verifyAppClient({
        clientId: created.app.clientId,
        clientSecret: rotated.clientSecret,
      }))!.appId,
    ).toBe(created.app.appId);
    const rows = await db.select().from(apps).where(eq(apps.id, created.app.id));
    expect(rows[0]!.rotatedAt).not.toBeNull();
  });

  it('订阅换绑:旧订阅上的 Key/App 批量改绑新订阅', async () => {
    const { owner, org } = await seedTeam(3);
    const subs = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.orgId, org.id));
    const oldSub = subs[0]!;
    const created = await api().createKey({
      userId: owner.id,
      name: 'k',
      subscriptionId: oldSub.id,
    });
    // 换绑目标:同 owner 的历史(非 active)订阅行——FK 真实存在
    const newSubRows = await db
      .insert(userSubscriptions)
      .values({
        userId: owner.id,
        planId: oldSub.planId,
        startAt: sql`clock_timestamp() - interval '60 days'`,
        endAt: sql`clock_timestamp() - interval '30 days'`,
        quotaAmount: '1000',
        quantity: 1,
        price: '1',
        status: 1,
      })
      .returning({ id: userSubscriptions.id });
    const newSub = newSubRows[0]!;
    const result = await api().rebindSubscription({
      fromSubscriptionId: oldSub.id,
      toSubscriptionId: newSub.id,
    });
    expect(result.keys).toBe(1);
    const row = await db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
    expect(row[0]!.subscriptionId).toBe(newSub.id);
  });

  it('钱包入账经替身桥接(生产为 billing):applyReferral 单事务双侧同生共死在真库回滚', async () => {
    const inviter = await api().provisionLocalAccount({
      email: `inv-${Math.random().toString(36).slice(2)}@x.io`,
    });
    const invitee = await api().provisionLocalAccount({
      email: `ite-${Math.random().toString(36).slice(2)}@x.io`,
    });
    await api().updateMarketingSettings({ patch: { referralSignupBonus: '1' }, adminId: 1 });
    h.wallet.failOnRefId(`referral-signup:${invitee.id}:invitee`);
    const aff = `u${inviter.id.toString(36)}`;
    await expect(
      api().applyReferral({ inviteeUserId: invitee.id, affCode: aff }),
    ).rejects.toThrow();
    const rel = await db.select().from(referrals).where(eq(referrals.inviteeUserId, invitee.id));
    expect(rel).toHaveLength(0); // 关系随事务回滚
  });
});
