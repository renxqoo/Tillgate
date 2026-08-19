/** 三张白名单守卫（必填，fail-closed）：堵三类静默错误——
 *  科目拼错静默建抽屉 / refType 拼错幂等域分裂双入账 / 币种拼错余额隐身。
 *  未声明即拒绝：错误消息附可用清单。 */
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createWallet } from '../wallet';
import { UnknownAccountCodeError, UnknownCurrencyError, UnknownRefTypeError } from '../index';
import { nextUser, ref, sameAmount, testPoolOptions } from './helpers';

const guardedPool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  options: testPoolOptions,
  max: 3,
});
const guardedDb = drizzle(guardedPool);

const gw = createWallet(guardedDb, {
  accounts: ['channel_cost', 'marketing_budget'],
  refTypes: ['topup', 'order', 'payout'],
  currencies: ['CNY', 'USD'],
});

afterAll(async () => {
  await guardedPool.end();
});

describe('科目白名单（accounts）', () => {
  it('拼错的 counterparty 拒绝并列出可用科目；不再静默建抽屉', async () => {
    const user = nextUser();
    const error = await gw
      .credit({
        userId: user,
        amount: '1',
        refType: 'topup',
        refId: ref(user, 'a'),
        counterparty: 'platfrom_revenue',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownAccountCodeError);
    expect((error as UnknownAccountCodeError).allowed).toContain('platform_revenue');
  });

  it('声明的科目可用；内置 outside/platform_revenue 免声明恒可用', async () => {
    const user = nextUser();
    await gw.credit({
      userId: user,
      amount: '8',
      refType: 'topup',
      refId: ref(user, 't'),
      counterparty: 'marketing_budget',
    });
    await gw.credit({ userId: user, amount: '2', refType: 'topup', refId: ref(user, 't2') }); // 缺省 outside
    expect(sameAmount(await gw.balance(user), '10')).toBe(true);
  });

  it('transfer 目标与 freeze 目标同样受白名单管', async () => {
    const user = nextUser();
    await gw.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await expect(
      gw.transfer({
        from: { userId: user },
        to: { code: 'typo_cost' },
        amount: '1',
        refType: 'payout',
        refId: ref(user, 'x'),
      }),
    ).rejects.toBeInstanceOf(UnknownAccountCodeError);
    await expect(
      gw.freeze({
        target: { code: 'typo_cost' },
        frozen: true,
        refType: 'payout',
        refId: ref(user, 'f'),
      }),
    ).rejects.toBeInstanceOf(UnknownAccountCodeError);
  });
});

describe('业务域白名单（refTypes）——防幂等域分裂双入账', () => {
  it('拼错的 refType 拒绝：同一单号不可能在两个域各入一次账', async () => {
    const user = nextUser();
    await gw.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'k') });
    await expect(
      gw.credit({ userId: user, amount: '10', refType: 'topups', refId: ref(user, 'k') }),
    ).rejects.toBeInstanceOf(UnknownRefTypeError);
    expect(sameAmount(await gw.balance(user), '10')).toBe(true); // 没有第二笔入账
  });

  it('settle/release 的 refType 同样受管', async () => {
    await expect(gw.settle({ refType: 'ordr', refId: 'x', amount: '1' })).rejects.toBeInstanceOf(
      UnknownRefTypeError,
    );
  });
});

describe('币种白名单（currencies）——防拼错币种余额隐身', () => {
  it('未声明币种拒绝（含缺省账户语义）', async () => {
    const user = nextUser();
    await expect(
      gw.credit({
        userId: user,
        currency: 'CNH',
        amount: '1',
        refType: 'topup',
        refId: ref(user, 'c'),
      }),
    ).rejects.toBeInstanceOf(UnknownCurrencyError);
    await expect(gw.balance(user, 'EUR')).rejects.toBeInstanceOf(UnknownCurrencyError);
    // 声明过的币种正常
    await gw.credit({
      userId: user,
      currency: 'USD',
      amount: '1',
      refType: 'topup',
      refId: ref(user, 'u'),
    });
    expect(sameAmount(await gw.balance(user, 'USD'), '1')).toBe(true);
  });
});
