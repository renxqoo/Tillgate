/**
 * 真实 PG 测试装置（*.real.test.ts 共享；默认门禁排除，经 test:real 显式运行）。
 *
 * 隔离策略：每文件独立随机 schema——应用 wallet 迁移链的 wallet 子集
 * （0059 建四表+触发器 → 0068 负余额 → 0069 相干性重写；0058 只退役遗留
 * users/fund_operations 列，与 wallet 四表无关，跳过），连接级 search_path 锁定
 * schema，结束 drop cascade。DDL 单一真源 = packages/db/migrations（不复制 SQL）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { pgSqlState } from '@tillgate/db';
import { closeDb, createDb, type Db } from '@tillgate/db';
import { createPostgresWalletStore } from '../src/adapters/postgres/wallet-store.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import type { WalletApi } from '../src/application/wallet/wallet.js';
import type { TxRetryPolicy } from '@tillgate/db';

export const REAL_URL = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** 依次应用的 wallet 迁移子集（覆盖 0058 之后的全部 wallet 语义） */
const WALLET_MIGRATIONS = [
  '0059_wallet_ledger_operations_convergence.sql',
  '0068_wallet_negative_settlement.sql',
  '0069_wallet_negative_coherence.sql',
];

/** 重试策略（与 db 包 transaction.ts 口径一致；生产缺省归 app config） */
export const V1_RETRY: TxRetryPolicy = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };

/** SQLSTATE 判等（db 包统一分类:pg 在 code、Bun SQL 在 errno——沿 cause 链双字段探测） */
export function causeChainHasCode(error: unknown, code: string): boolean {
  return pgSqlState(error) === code;
}

/**
 * 42P01 容忍白名单（迁移文件名）：db 链中少数历史迁移引用「在本回放序中后建」的表
 * （identity provision 族——0055/0056/0057 的目标表 0076 才建）。容忍必须同时满足
 * 三重判定：文件在白名单 + 错误码 42P01 + 服务端消息确为 relation ... does not exist。
 * 单看错误码不可信：Bun SQL 的 errno 映射有损——曾把 42P10（invalid reference）错映
 * 为 42P01 而被静默放行非法语句（e2e 装置同源缺陷，e2e/gateway/kit.ts 同款收紧）。
 */
const REPLAY_MISSING_RELATION_ALLOWLIST = new Set([
  '0055_session_anchors_backfill.sql',
  '0056_ledger_operations_backfill.sql',
  '0057_payment_orders_fk_ledger_operations.sql',
]);

/** 沿 cause 链收集全部 message（drizzle 包装层是 Failed query…，服务端真话在 cause） */
function chainMessages(error: unknown): string[] {
  const messages: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const { message } = cur as { message?: unknown };
    if (typeof message === 'string') messages.push(message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return messages;
}

/** 全链回放容忍判定（纯函数；e2e/gateway/kit.ts 同款语义） */
export function replayTolerates(error: unknown, file: string): boolean {
  if (!REPLAY_MISSING_RELATION_ALLOWLIST.has(file)) return false;
  if (!causeChainHasCode(error, '42P01')) return false;
  return chainMessages(error).some((m) => /relation "[^"]+" does not exist/.test(m));
}

export interface RealWalletHarness {
  db: Db;
  api: WalletApi;
  teardown(): Promise<void>;
}

export async function setupRealWallet(label: string): Promise<RealWalletHarness> {
  if (!REAL_URL) throw new Error('DB_TEST_URL / DATABASE_URL 未设置');
  const schema = `tillgate_billing_${label}_${process.pid.toString(36)}`;
  const [baseUrl] = REAL_URL.split('?');
  // 连接级 search_path：DDL 与查询（含触发器内未限定表名）全部落在隔离 schema
  const scopedUrl = `${baseUrl}?options=-c%20search_path%3D${schema}`;
  const db = createDb({
    url: scopedUrl,
    poolMax: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
  });
  await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
  await db.execute(sql.raw(`create schema ${schema}`));
  for (const file of WALLET_MIGRATIONS) {
    const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
  }
  const store = createPostgresWalletStore(db, { retry: V1_RETRY });
  const api = createWalletApi({
    store,
    guards: {
      refTypes: ['billing', 'topup', 'admin', 'gift'],
      currencies: ['CNY', 'USD'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  return {
    db,
    api,
    teardown: async () => {
      await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await closeDb(db);
    },
  };
}

/** 账本不变量核验（对账哨兵口径子集；纯 SELECT） */
export async function assertLedgerCoherent(db: Db): Promise<void> {
  const unbalanced = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select l.transaction_id from wallet_legs l
      group by l.transaction_id having sum(l.amount) <> 0
    ) t`);
  expect0(unbalanced, 'transactions with unbalanced legs');

  const chainBroken = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from wallet_legs a
    join wallet_legs b on b.account_id = a.account_id and b.id > a.id
      and b.balance_before <> a.balance_after
    where not exists (
      select 1 from wallet_legs m where m.account_id = a.account_id
        and m.id > a.id and m.id < b.id)`);
  expect0(chainBroken, 'broken leg chain (after != next before)');

  const balanceDrift = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from wallet_accounts ac
    where ac.balance <> coalesce((
      select l.balance_after from wallet_legs l where l.account_id = ac.id
      order by l.id desc limit 1), 0)`);
  expect0(balanceDrift, 'account balance differs from final leg');

  const inFlightDrift = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from wallet_accounts ac
    where ac.in_flight <> coalesce((
      select sum(a.amount) from wallet_authorizations a
      where a.account_id = ac.id and a.status = 'active'), 0)`);
  expect0(inFlightDrift, 'in_flight differs from active authorizations');
}

function expect0(result: Array<Record<string, unknown>>, what: string): void {
  const n = Number(result[0]?.n ?? -1);
  if (n !== 0) throw new Error(`ledger incoherent: ${what} = ${n}`);
}

export interface RealFullSchemaHarness {
  db: Db;
  teardown(): Promise<void>;
}

/**
 * 完整迁移链装置（供订阅/支付竞态套件复用）：
 * 隔离 schema 应用 0000→最新全链——库表初始化容忍 42P01（db 链跨链引用缺口，
 * 如 identity-core provision 建的表），其余错误照常失败；
 * 个别迁移硬编码 public. 前缀重写到隔离 schema（DDL 内无业务字符串）。
 */
export async function setupRealFullSchema(label: string): Promise<RealFullSchemaHarness> {
  if (!REAL_URL) throw new Error('DB_TEST_URL / DATABASE_URL 未设置');
  const schema = `tillgate_billing_${label}_${process.pid.toString(36)}`;
  const [baseUrl] = REAL_URL.split('?');
  const db = createDb({
    url: `${baseUrl}?options=-c%20search_path%3D${schema}`,
    poolMax: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
  });
  await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
  await db.execute(sql.raw(`create schema ${schema}`));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .toSorted();
  for (const file of files) {
    const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement
        .trim()
        .replaceAll('public.', `${schema}.`)
        .replaceAll('"public"', `"${schema}"`);
      if (!trimmed) continue;
      try {
        await db.execute(sql.raw(trimmed));
      } catch (error) {
        // 白名单内且确为「关系不存在」才容忍（见 replayTolerates 注释）——其余响亮失败
        if (replayTolerates(error, file)) continue;
        throw error;
      }
    }
  }
  return {
    db,
    teardown: async () => {
      await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await closeDb(db);
    },
  };
}
