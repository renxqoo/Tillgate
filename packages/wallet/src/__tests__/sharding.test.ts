import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWallet } from '../wallet';
import { walletAccounts } from '../schema';
import { Decimal } from '../money';
import { selectInternalShard } from '../sharding';
import { db, nextUser, ref, sameAmount } from './helpers';

const sharded = createWallet(db, {
  accounts: ['hot_source', 'hot_revenue', 'resizable_revenue'],
  refTypes: ['topup', 'order', 'p2p', 'risk_control', 'credit_line'],
  currencies: ['CNY'],
  internalAccountShards: 8,
});

async function logicalBalance(code: string): Promise<string> {
  const rows = await db
    .select({ balance: walletAccounts.balance })
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.kind, 'internal'),
        eq(walletAccounts.code, code),
        eq(walletAccounts.currency, 'CNY'),
      ),
    );
  return rows.reduce((total, row) => total.plus(row.balance), new Decimal(0)).toString();
}

describe('内部科目分片', () => {
  it('写入分散到多个物理分片，逻辑转出仍按聚合余额执行', async () => {
    const users = Array.from({ length: 16 }, () => nextUser());
    await Promise.all(
      users.map(async (user) => {
        await sharded.credit({
          userId: user,
          amount: '10',
          counterparty: 'hot_source',
          refType: 'topup',
          refId: ref(user, 'shard-fund'),
        });
        await sharded.authorize({
          userId: user,
          amount: '5',
          refType: 'order',
          refId: ref(user, 'shard-hold'),
        });
        await sharded.settle({
          refType: 'order',
          refId: ref(user, 'shard-hold'),
          amount: '5',
          counterparty: 'hot_revenue',
        });
      }),
    );

    const revenueShards = await db
      .select({ id: walletAccounts.id })
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.kind, 'internal'),
          eq(walletAccounts.code, 'hot_revenue'),
          eq(walletAccounts.currency, 'CNY'),
        ),
      );
    expect(revenueShards.length).toBeGreaterThan(1);
    expect(sameAmount(await logicalBalance('hot_revenue'), '80')).toBe(true);

    const merchant = nextUser();
    await sharded.transfer({
      from: { code: 'hot_revenue' },
      to: { userId: merchant },
      amount: '60',
      refType: 'p2p',
      refId: ref(merchant, 'shard-payout'),
    });
    expect(sameAmount(await sharded.balance(merchant), '60')).toBe(true);
    expect(sameAmount(await logicalBalance('hot_revenue'), '20')).toBe(true);
  });

  it('冻结逻辑科目会覆盖全部分片', async () => {
    const marker = nextUser();
    await sharded.freeze({
      target: { code: 'hot_source' },
      frozen: true,
      refType: 'risk_control',
      refId: ref(marker, 'freeze-source'),
    });
    await expect(
      sharded.credit({
        userId: nextUser(),
        amount: '1',
        counterparty: 'hot_source',
        refType: 'topup',
        refId: ref(marker, 'blocked-credit'),
      }),
    ).rejects.toMatchObject({ code: 'account_frozen' });
  });

  it('调整分片配置不会遗忘历史分片余额', async () => {
    const source = nextUser();
    await sharded.setCreditLimit({
      userId: source,
      amount: '12',
      refType: 'credit_line',
      refId: ref(source, 'resize-limit'),
    });
    const holdKey = Array.from({ length: 100 }, (_, index) => ref(source, `resize-hold-${index}`)).find(
      (candidate) => selectInternalShard('order', candidate, 8) >= 4,
    )!;
    await sharded.authorize({
      userId: source,
      amount: '12',
      refType: 'order',
      refId: holdKey,
    });
    await sharded.settle({
      refType: 'order',
      refId: holdKey,
      amount: '12',
      counterparty: 'resizable_revenue',
    });

    const resized = createWallet(db, {
      accounts: ['resizable_revenue'],
      refTypes: ['p2p'],
      currencies: ['CNY'],
      internalAccountShards: 4,
    });
    const target = nextUser();
    await resized.transfer({
      from: { code: 'resizable_revenue' },
      to: { userId: target },
      amount: '12',
      refType: 'p2p',
      refId: ref(target, 'resize-payout'),
    });
    expect(sameAmount(await resized.balance(target), '12')).toBe(true);
    expect(sameAmount(await logicalBalance('resizable_revenue'), '0')).toBe(true);
  });
});
