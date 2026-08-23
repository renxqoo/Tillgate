/**
 * billing FundingSourceResolver 桥的真实 PG 契约（*.real.test.ts；默认门禁排除）：
 * 凭证三分支（key 优先 / app 次之 / 兜底）× 限额透传。语义 = v1 credential.repo
 * resolveSourceAndLimits。隔离 schema + 最小 DDL（users/api_keys/apps 三表——与
 * packages/db schema 同拍的最小子集，仅本表族消费列）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from '@tokenlens/db';
import { createPgFundingSourceResolver } from '../src/adapters/postgres/funding-resolver.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

describe.skipIf(url == null)('FundingSourceResolver 桥（真实 PG）', () => {
  let db: Db;
  let schema = '';
  /** billing 侧传入的事务句柄结构形状（真实 DbTx 有 select/insert…；此处直传 db 句柄） */
  let conn: { readonly connBrand: 'wallet-conn' };

  beforeAll(async () => {
    schema = `tokenlens_acc_fund_${process.pid.toString(36)}_${Date.now().toString(36)}`;
    const [baseUrl] = url!.split('?');
    db = createDb({
      url: `${baseUrl}?options=-c%20search_path%3D${schema}`,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 1_000,
    });
    conn = db as unknown as { readonly connBrand: 'wallet-conn' };
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`
      create table users (id bigserial primary key, daily_spend_limit numeric(38,18));
      create table apps (id bigserial primary key, user_id bigint not null, subscription_id bigint);
      create table api_keys (
        id bigserial primary key,
        user_id bigint not null,
        app_id bigint,
        subscription_id bigint,
        daily_spend_limit numeric(38,18),
        allow_payg_fallback boolean not null default false
      );
    `));
    // 种子：user 1（限 50 / 绑 sub 9 的 key 1，key 级限 10，允许 fallback）
    await db.execute(
      sql`insert into users (id, daily_spend_limit) values (1, 50), (2, null)`,
    );
    await db.execute(
      sql`insert into api_keys (id, user_id, subscription_id, daily_spend_limit, allow_payg_fallback)
          values (1, 1, 9, 10, true), (2, 2, null, null, false)`,
    );
    await db.execute(sql`insert into apps (id, user_id, subscription_id) values (5, 1, 77)`);
  });

  afterAll(async () => {
    if (schema) await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await closeDb(db);
  });

  it('key 分支：订阅绑定 + key 级限额 + fallback 全透传；user 限额独立读', async () => {
    const resolver = createPgFundingSourceResolver();
    const resolved = await resolver.resolve(conn, { userId: 1, apiKeyId: 1, appId: null });
    expect(resolved).toEqual({
      subscriptionId: 9,
      allowPaygFallback: true,
      userDailyLimit: '50.000000000000000000',
      keyDailyLimit: '10.000000000000000000',
    });
  });

  it('app 分支：订阅绑定透传；App-JWT 恒 allowPaygFallback=false / 无 key 限额', async () => {
    const resolver = createPgFundingSourceResolver();
    const resolved = await resolver.resolve(conn, { userId: 1, apiKeyId: null, appId: 5 });
    expect(resolved).toEqual({
      subscriptionId: 77,
      allowPaygFallback: false,
      userDailyLimit: '50.000000000000000000',
      keyDailyLimit: null,
    });
  });

  it('兜底分支：无凭证事实不编造；user 无限额 = null', async () => {
    const resolver = createPgFundingSourceResolver();
    expect(await resolver.resolve(conn, { userId: 2, apiKeyId: null, appId: null })).toEqual({
      subscriptionId: null,
      allowPaygFallback: false,
      userDailyLimit: null,
      keyDailyLimit: null,
    });
    // key 不存在（吊销后残留调用）= 兜底，不抛
    expect(await resolver.resolve(conn, { userId: 2, apiKeyId: 999, appId: null })).toEqual({
      subscriptionId: null,
      allowPaygFallback: false,
      userDailyLimit: null,
      keyDailyLimit: null,
    });
  });
});
