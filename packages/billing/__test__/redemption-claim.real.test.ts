/**
 * 兑换码 claim 真实 PostgreSQL 契约（B-red-claim 回归）：
 * client-api E2E 旅程实测发现——claim 的 UPDATE ... RETURNING 引用了未 JOIN 的
 * 批次表列，渲染成裸列名后 PG 42703（column "amount" does not exist），
 * 兑换动词全路径 500。回归锁死：未知码 → null（不发 SQL 错）；有效码 → 返回
 * 批次面额；重复 claim → null（CAS 单赢家）。默认门禁排除（铁律 14），
 * 经 `bun run test:real`（DB_TEST_URL / DATABASE_URL）显式运行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { createPostgresRedeemCodeStore } from '../src/adapters/postgres/payment-stores.js';
import { sha256Hex } from '../src/application/redemption/redemption.js';
import { redeemBatches, redeemCodes } from '@tillgate/db/schema';
import { defined } from './defined.js';

const REAL_URL = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

/** 镜像 db schema 的兑换域 DDL（隔离 schema；与 real-pg.ts 同款 search_path 手法） */
const DDL = `
create table users (id bigserial primary key);
create table redeem_batches (
  id bigserial primary key,
  name varchar(64) not null,
  remark varchar(255),
  amount numeric(38,18) not null,
  total bigint not null,
  used_count bigint not null default 0,
  created_by bigint not null,
  created_at timestamptz not null default now()
);
create table redeem_codes (
  id bigserial primary key,
  batch_id bigint not null references redeem_batches(id),
  code_hash varchar(64) not null,
  status smallint not null default 0,
  used_by bigint references users(id),
  used_at timestamptz,
  expires_at timestamptz,
  constraint redeem_codes_hash_uq unique (code_hash)
);
`;

(REAL_URL ? describe : describe.skip)('兑换码 claim 真实 PG 契约', () => {
  let db: Db;
  /** WalletConn 是包内不透明品牌——存储层 tx() 同款反向提升（测试专用缝） */
  let conn: Parameters<ReturnType<typeof createPostgresRedeemCodeStore>['claim']>[0];
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `billing_redeem_claim_${process.pid.toString(36)}`;
    const [baseUrl] = (REAL_URL as string).split('?');
    db = createDb({
      url: `${baseUrl}?options=-c%20search_path%3D${schemaName}`,
      poolMax: 3,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    await db.execute(sql.raw(`drop schema if exists ${schemaName} cascade`));
    await db.execute(sql.raw(`create schema ${schemaName}`));
    await db.execute(sql.raw(DDL));
    conn = db as unknown as typeof conn;
  });

  afterAll(async () => {
    await db.execute(sql.raw(`drop schema if exists ${schemaName} cascade`));
    await closeDb(db);
  });

  it('B-red-claim 回归：未知码 claim 返回 null（不抛 42703）；有效码返回批次面额；重复 claim 单赢家', async () => {
    const store = createPostgresRedeemCodeStore(db);
    // 裸 db → WalletConn 形状适配(同一 drizzle 实例;品牌类型仅约束装配面)
    const walletConn = db as unknown as Parameters<typeof store.claim>[0];
    const now = new Date();

    // 未知码：claim 直接 0 行 → null（bug 形态是 SQL 解析期 42703，连未知码路径都炸）
    const unknown = await store.claim(walletConn, {
      codeHash: sha256Hex('NO-SUCH-CODE'),
      userId: 1,
      now,
    });
    expect(unknown).toBeNull();

    // 造一个用户 + 批次（面额 12.50）+ 未用码
    await db.execute(sql`insert into users (id) values (7)`);
    const [batch] = await db
      .insert(redeemBatches)
      .values({ name: 'regression', amount: '12.50', total: 1, createdBy: 1 })
      .returning({ id: redeemBatches.id });
    const codeHash = sha256Hex('REGRESSION-CODE-1');
    await db.insert(redeemCodes).values({ batchId: defined(batch).id, codeHash, status: 0 });

    const claimed = await store.claim(walletConn, { codeHash, userId: 7, now });
    // 存储层返回原始 numeric 全精度串（应用层 normalizeAmount 归一）
    expect(claimed).toEqual({
      codeId: expect.any(Number),
      batchId: defined(batch).id,
      amount: '12.500000000000000000',
    });

    // CAS 单赢家：同码二次 claim → null（status 已 1）
    const again = await store.claim(walletConn, { codeHash, userId: 7, now });
    expect(again).toBeNull();

    // 状态落库核验
    const [row] = await db
      .select({ status: redeemCodes.status, usedBy: redeemCodes.usedBy })
      .from(redeemCodes)
      .where(eq(redeemCodes.codeHash, codeHash));
    expect(row).toEqual({ status: 1, usedBy: 7 });
  });

  it('过期码不可 claim（读时过期口径）', async () => {
    const store = createPostgresRedeemCodeStore(db);
    // 裸 db → WalletConn 形状适配(同一 drizzle 实例;品牌类型仅约束装配面)
    const walletConn = db as unknown as Parameters<typeof store.claim>[0];
    const [batch] = await db
      .insert(redeemBatches)
      .values({ name: 'expired', amount: '1', total: 1, createdBy: 1 })
      .returning({ id: redeemBatches.id });
    const codeHash = sha256Hex('EXPIRED-CODE-1');
    await db.insert(redeemCodes).values({
      batchId: defined(batch).id,
      codeHash,
      status: 0,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const claimed = await store.claim(walletConn, { codeHash, userId: 7, now: new Date() });
    expect(claimed).toBeNull();
  });
});
