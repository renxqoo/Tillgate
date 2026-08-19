/** 运行与治理契约：多 worker、公平扫描、运行时输入、配置和迁移升级。 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { InvalidInputError, UnknownCurrencyError } from '../errors';
import { migrateWallet, walletSchemaMigrations } from '../migrations';
import { createWalletMaintenance } from '../maintenance';
import { createWallet } from '../wallet';
import { walletAuthorizations } from '../schema';
import { accountOf, db, nextUser, ref, sameAmount, wallet } from './helpers';

describe('过期任务生产语义', () => {
  it('维护入口可周期性核验全账本，不要求业务方导入底层表', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user,
      amount: '4',
      refType: 'topup',
      refId: ref(user, 'verify'),
    });
    const report = await createWalletMaintenance(db).verifyInvariants();
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('多个 worker 用 SKIP LOCKED 分批处理，不重复也不遗漏', async () => {
    const users = Array.from({ length: 6 }, () => nextUser());
    for (const user of users) {
      await wallet.credit({
        userId: user,
        amount: '10',
        refType: 'topup',
        refId: ref(user, 'fund'),
      });
      await wallet.authorize({
        userId: user,
        amount: '1',
        refType: 'order',
        refId: ref(user, 'expired'),
        expiresAt: new Date(Date.now() - 60_000),
      });
    }

    const maintenance = createWalletMaintenance(db);
    const results = await Promise.all([
      maintenance.releaseExpired(2),
      maintenance.releaseExpired(2),
      maintenance.releaseExpired(2),
    ]);
    expect(results.reduce((sum, item) => sum + item.released, 0)).toBe(6);
    for (const user of users) expect(sameAmount((await accountOf(user)).inFlight, '0')).toBe(true);
  });

  it('releaseExpired 只接受批大小，并使用数据库权威时钟', async () => {
    const maintenance = createWalletMaintenance(db);
    await expect(maintenance.releaseExpired(0)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(maintenance.releaseExpired(1001)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('运行时配置与输入', () => {
  it('业务 Facade 不暴露批量过期能力', () => {
    expect(wallet).not.toHaveProperty('releaseExpired');
  });

  it('生产 Facade 发出成功/失败操作指标，不泄漏敏感输入', async () => {
    const events: unknown[] = [];
    const observed = createWallet(db, {
      accounts: [],
      refTypes: ['topup'],
      currencies: ['CNY'],
      telemetry: { onOperation: (event) => events.push(event) },
    });
    const user = nextUser();
    await observed.credit({
      userId: user,
      amount: '1',
      refType: 'topup',
      refId: ref(user, 'observed'),
    });
    await expect(
      observed.credit({ userId: user, amount: '0', refType: 'topup', refId: ref(user, 'bad') }),
    ).rejects.toThrow();
    expect(events).toEqual([
      expect.objectContaining({ operation: 'credit', outcome: 'success', replayed: false }),
      expect.objectContaining({
        operation: 'credit',
        outcome: 'error',
        errorCode: 'invalid_amount',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(ref(user, 'observed'));
  });

  it('createWallet 在启动时校验白名单及 defaultCurrency', () => {
    expect(() =>
      createWallet(db, { accounts: [], refTypes: ['topup'], currencies: ['USD'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: ['Bad-Code'], refTypes: ['topup'], currencies: ['CNY'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: [], refTypes: ['TOPUP'], currencies: ['CNY'] }),
    ).toThrow(InvalidInputError);
    for (const internalAccountShards of [0, 257, 1.5]) {
      expect(() =>
        createWallet(db, {
          accounts: [],
          refTypes: ['topup'],
          currencies: ['CNY'],
          internalAccountShards,
        }),
      ).toThrow(InvalidInputError);
    }
    // 查重与归属：任一白名单重复、defaultCurrency 不在 currencies、列表为空、非对象入参均拒绝
    expect(() =>
      createWallet(db, { accounts: ['fee_a', 'fee_a'], refTypes: ['topup'], currencies: ['CNY'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: [], refTypes: ['topup', 'topup'], currencies: ['CNY'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: [], refTypes: ['topup'], currencies: ['CNY', 'CNY'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, {
        accounts: [],
        refTypes: ['topup'],
        currencies: ['CNY', 'USD'],
        defaultCurrency: 'EUR',
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: [], refTypes: [], currencies: ['CNY'] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, { accounts: [], refTypes: ['topup'], currencies: [] }),
    ).toThrow(InvalidInputError);
    expect(() =>
      createWallet(db, undefined as unknown as Parameters<typeof createWallet>[1]),
    ).toThrow(InvalidInputError);
  });

  it('可显式选择默认币种，所有缺省读写保持一致', async () => {
    const usd = createWallet(db, {
      accounts: [],
      refTypes: ['topup'],
      currencies: ['USD'],
      defaultCurrency: 'USD',
    });
    const user = nextUser();
    await usd.credit({ userId: user, amount: '3', refType: 'topup', refId: ref(user, 'usd') });
    expect(sameAmount(await usd.balance(user), '3')).toBe(true);
    expect((await usd.accounts(user)).map((item) => item.currency)).toEqual(['USD']);
  });

  it('所有公开输入错误都归一为 WalletError，而不是裸 Zod/TypeError', async () => {
    const user = nextUser();
    await expect(
      wallet.freeze({
        target: { userId: user },
        frozen: 'yes' as unknown as boolean,
        refType: 'risk_control',
        refId: ref(user, 'bad-freeze'),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      wallet.authorize({
        userId: user,
        amount: '1',
        refType: 'order',
        refId: ref(user, 'bad-date'),
        expiresAt: new Date('invalid'),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      wallet.release({ refType: 'order', refId: ref(user, 'missing'), reason: 'x'.repeat(65) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('statement 也遵循 currency 白名单', async () => {
    const cnyOnly = createWallet(db, { accounts: [], refTypes: ['topup'], currencies: ['CNY'] });
    await expect(cnyOnly.statement({ userId: nextUser(), currency: 'USD' })).rejects.toBeInstanceOf(
      UnknownCurrencyError,
    );
  });

  it('authorize memo 进入冻结单审计记录，不静默丢失', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '2', refType: 'topup', refId: ref(user, 'fund') });
    const key = ref(user, 'memo-hold');
    await wallet.authorize({
      userId: user,
      amount: '1',
      refType: 'order',
      refId: key,
      memo: '订单风险预占',
    });
    const [row] = await db
      .select()
      .from(walletAuthorizations)
      .where(sql`${walletAuthorizations.refId} = ${key}`);
    expect(row?.memo).toBe('订单风险预占');
  });
});

describe('版本化迁移', () => {
  it('测试套件运行在随机隔离 schema，不触碰 public 开发表', async () => {
    const result = await db.execute(sql`select current_schema() as schema`);
    expect(String(result.rows[0]?.schema)).toMatch(/^wallet_test_/);
  });

  it('可从 N-1 升到最新版，并记录不可变 checksum', async () => {
    const schema = `wallet_migration_test_${randomUUID().replaceAll('-', '')}`;
    const connectionString =
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const isolated = drizzle(pool);
    try {
      const previous = walletSchemaMigrations.slice(0, -1);
      for (const migration of previous) {
        for (const statement of migration.statements) await isolated.execute(sql.raw(statement));
      }
      await isolated.execute(
        sql.raw(`
        create table wallet_schema_migrations (
          version integer primary key, name varchar(128) not null,
          checksum varchar(64) not null, applied_at timestamptz not null default now()
        )
      `),
      );
      for (const migration of previous) {
        await isolated.execute(sql`
          insert into wallet_schema_migrations (version, name, checksum)
          values (${migration.version}, ${migration.name}, ${migration.checksum})
        `);
      }
      await isolated.execute(sql`
        insert into wallet_accounts (kind, code, currency)
        values ('internal', 'legacy_revenue', 'CNY')
      `);

      await migrateWallet(isolated);
      await migrateWallet(isolated);
      const rows = await isolated.execute(sql`
        select version, checksum from wallet_schema_migrations order by version
      `);
      expect(rows.rows).toEqual(
        walletSchemaMigrations.map((item) => ({ version: item.version, checksum: item.checksum })),
      );
      const legacy = await isolated.execute(sql`
        select shard from wallet_accounts where code = 'legacy_revenue'
      `);
      expect(legacy.rows).toEqual([{ shard: 0 }]);
    } finally {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
});
