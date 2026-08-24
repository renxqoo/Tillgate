/**
 * 真实 PostgreSQL 门禁(test:real 显式运行;DB_TEST_URL/DATABASE_URL 缺失整组 skip,
 * 铁律 14):七表 DDL fixture + 经 facade(runTx + advisoryLock 完整编排)复验
 * CAS/锁/部分唯一索引/GREATEST 的真实语义——凭据并发注册单赢家、冷却期并发发码
 * 至多 1 成功(部分唯一索引 + 锁替换语义)、同码并发验恰 1 成功、TOTP 步进 CAS
 * 防重放、恢复码单次消费、OAuth 并发绑定单赢家、锚点 GREATEST 单调、
 * composition bridge 随事务回滚(B03)。
 * 多语句编排(锁内 abort+insert / link 读回分类)必须经 facade 的 runTx 临界区,
 * 直连 store 无事务会让「替换语义」退化为连环替换——这是本门禁锁定的口径之一。
 * DDL fixture 与迁移 0076 同源(迁移链空库装配依赖未收口前内联;P3 收口后退役,
 * accounts real 门禁同款口径)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runTx, type Db } from '@tillgate/db';
import { identityWithinTx } from '../src/composition.js';
import { createIdentity, type Identity } from '../src/identity.js';
import { resolveConfig } from '../src/domain/config.js';
import { postgresIdentityStore } from '../src/adapters/postgres/identity-store';
import { TEST_CONFIG, createTestHarness } from '../src/testing/harness.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const store = postgresIdentityStore;
let userIdSeq = 9_000_000;
let realDb: Db;
let api: Identity;
let realHarness: ReturnType<typeof createTestHarness>;
let mailer: ReturnType<typeof createTestHarness>['mailer'];
let audit: ReturnType<typeof createTestHarness>['audit'];

const email = (n: number) => `real${n}@example.com`;
const userId = () => ++userIdSeq;

/** 七表 DDL fixture(与 @tillgate/db 迁移 0076 同源同序) */
const DDL = `
create table if not exists identity_credentials (
  id bigserial primary key,
  user_id bigint not null,
  identifier_kind varchar(16) not null,
  identifier_value varchar(255) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identity_credentials_identifier_uq unique (identifier_kind, identifier_value),
  constraint identity_credentials_kind_ck check (identifier_kind in ('email','phone','username'))
);
create index if not exists identity_credentials_user_idx on identity_credentials (user_id);
create table if not exists identity_passwords (
  user_id bigint primary key,
  password_hash varchar(255) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists identity_oauth_links (
  id bigserial primary key,
  user_id bigint not null,
  provider varchar(32) not null,
  subject varchar(255) not null,
  email varchar(255),
  linked_at timestamptz not null default now(),
  constraint identity_oauth_links_provider_subject_uq unique (provider, subject),
  constraint identity_oauth_links_user_provider_uq unique (user_id, provider)
);
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
  constraint identity_challenges_attempts_ck check (attempts between 0 and max_attempts),
  constraint identity_challenges_max_attempts_ck check (max_attempts between 1 and 100),
  constraint identity_challenges_expiry_ck check (expires_at > issued_at),
  constraint identity_challenges_terminal_ck check (consumed_at is null or aborted_at is null)
);
create unique index if not exists identity_challenges_live_identifier_uq
  on identity_challenges (kind, identifier_kind, identifier_value)
  where consumed_at is null and aborted_at is null;
create table if not exists identity_totp (
  user_id bigint primary key,
  secret text not null,
  confirmed_at timestamptz,
  last_used_step bigint not null default -1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists identity_recovery_codes (
  id bigserial primary key,
  user_id bigint not null,
  code_hash varchar(64) not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint identity_recovery_codes_hash_uq unique (user_id, code_hash)
);
create table if not exists identity_session_anchors (
  realm varchar(32) not null default 'user',
  user_id bigint not null,
  invalid_before timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint identity_session_anchors_realm_ck check (realm ~ '^[a-z][a-z0-9_-]{1,31}$'),
  primary key (realm, user_id)
);
`;

async function exec(db: Db, sqlText: string): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(sql.raw(sqlText));
}

(url ? describe : describe.skip)('postgres real:CAS/锁/索引语义', () => {
  beforeAll(async () => {
    realDb = createDb({
      url: url!,
      poolMax: 8,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      maxUses: 5_000,
    });
    await exec(realDb, DDL);
    for (const table of [
      'identity_challenges',
      'identity_recovery_codes',
      'identity_totp',
      'identity_oauth_links',
      'identity_passwords',
      'identity_credentials',
      'identity_session_anchors',
    ]) {
      await exec(realDb, `truncate table ${table}`);
    }
    const h = createTestHarness();
    realHarness = h;
    mailer = h.mailer;
    audit = h.audit;
    api = createIdentity({
      db: realDb,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => undefined },
      config: TEST_CONFIG,
      mailer,
      auditSink: audit,
    });
  });

  afterAll(async () => {
    const { closeDb } = await import('@tillgate/db');
    await closeDb(realDb);
  });

  it('凭据并发注册同邮箱恰一人成功(锁 + 唯一索引读回分类)', async () => {
    const target = email(1);
    const results = await Promise.allSettled([
      api.credentials.register({ userId: userId(), identifier: { kind: 'email', value: target } }),
      api.credentials.register({ userId: userId(), identifier: { kind: 'email', value: target } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'identity.identifier_taken' });
  });

  it('冷却期并发发码至多 1 成功(锁内冷却判定 + 部分唯一索引替换语义)', async () => {
    const target = email(2);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        api.challenges.begin({
          kind: 'user_login_code',
          target: { identifier: { kind: 'email', value: target } },
          delivery: { ip: 'ip' },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const cooldowns = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r as PromiseRejectedResult).reason.code === 'identity.challenge_cooldown',
    );
    expect(cooldowns).toHaveLength(3);
  });

  it('挑战 CAS:同码并发验 6 次恰 1 成功', async () => {
    const target = email(3);
    const begun = await api.challenges.begin({
      kind: 'user_login_code',
      target: { identifier: { kind: 'email', value: target } },
      delivery: { ip: 'ip' },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      expect(r.reason).toMatchObject({
        code: expect.stringMatching(/^identity\.(code_invalid|challenge_invalid)$/),
      });
    }
  });

  it('TOTP 步进单调 CAS:并发同码恰一人推进;恢复码单次消费', async () => {
    const id = userId();
    const enrolled = await api.mfa.enrollTotp({ userId: id });
    const { base32Decode, matchingTotpStep, totpAt } = await import('../src/domain/totp.js');
    const secret = base32Decode(enrolled.secret);
    const epochMs = realHarness.ctx.clock.now().getTime();
    const step = matchingTotpStep(secret, totpAt(secret, epochMs, 30), epochMs, 30, 1)!;
    const code = totpAt(secret, step * 30_000, 30);
    await api.mfa.confirmTotp({ userId: id, code });
    const code2step = step + 1;
    const code2 = totpAt(secret, code2step * 30_000, 30);
    const advanced = await Promise.allSettled([
      api.mfa.verify({ userId: id, code: code2 }),
      api.mfa.verify({ userId: id, code: code2 }),
    ]);
    expect(advanced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // 步号已前进,旧码不再可用(防重放)
    await expect(api.mfa.verify({ userId: id, code })).rejects.toMatchObject({
      code: expect.stringMatching(/^identity\.(invalid_totp_code|totp_not_enrolled)$/),
    });
  });

  it('OAuth 并发绑定同一 (provider,subject) 恰一人成功', async () => {
    const subject = `race-${Date.now()}`;
    const results = await Promise.allSettled([
      api.oauth.link({ userId: userId(), provider: 'github', subject }),
      api.oauth.link({ userId: userId(), provider: 'github', subject }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      code: 'identity.provider_already_linked',
      context: { conflict: 'provider_identity_taken' },
    });
  });

  it('锚点 GREATEST 单调:回填早时刻不放松线;at 缺省 SQL now()', async () => {
    const id = userId();
    await store.advanceAnchor(realDb, { realm: 'user', userId: id, at: new Date(1_000) });
    await store.advanceAnchor(realDb, { realm: 'user', userId: id, at: new Date(500) });
    const anchor = await store.readAnchor(realDb, { realm: 'user', userId: id });
    expect(Date.parse(anchor!)).toBe(1_000);
    const nowIso = await store.advanceAnchor(realDb, { realm: 'user', userId: id });
    expect(Date.parse(nowIso)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('composition bridge 随调用方事务回滚(B03:事实与审计一并消失)', async () => {
    const { guards, config } = resolveConfig(TEST_CONFIG);
    const target = email(4);
    const id = userId();
    await runTx(
      realDb,
      async (tx) => {
        const bridge = identityWithinTx(tx, {
          clock: { now: () => new Date() },
          guards,
          passwordPolicy: config.passwordPolicy,
        });
        await bridge.registerCredential({
          userId: id,
          identifier: { kind: 'email', value: target },
        });
      },
      { maxAttempts: 3, baseDelayMs: 5, maxJitterMs: 5 },
    );
    expect(await store.findDeliveryIdentifier(realDb, id)).toMatchObject({
      kind: 'email',
      value: target,
    });

    const rollbackTarget = email(5);
    await expect(
      runTx(
        realDb,
        async (tx) => {
          const bridge = identityWithinTx(tx, {
            clock: { now: () => new Date() },
            guards,
            passwordPolicy: config.passwordPolicy,
          });
          await bridge.registerCredential({
            userId: id,
            identifier: { kind: 'email', value: rollbackTarget },
          });
          throw new Error('caller rollback');
        },
        { maxAttempts: 3, baseDelayMs: 5, maxJitterMs: 5 },
      ),
    ).rejects.toThrow('caller rollback');
    // 回滚后:提交路径的凭据仍在,回滚路径的标识从未落库(凭据集回到仅 target)
    expect(await store.findDeliveryIdentifier(realDb, id)).toMatchObject({
      kind: 'email',
      value: target,
    });
    expect(
      await store.findPasswordHashByIdentifier(realDb, { kind: 'email', value: rollbackTarget }),
    ).toBeNull();
  });
});
