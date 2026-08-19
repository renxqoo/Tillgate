// wallet 边缘：金额与词表边界 → 模块化测试（源自 wallet.test.ts 拆分）

import { wallet, walletMaintenance, nextUser, ref, sameAmount } from './helpers';
import { describe, expect, it } from 'vitest';
describe('边缘：金额与词表边界', () => {
  it('金额字符串格式边界：合法接受 / 非法拒绝一览', async () => {
    const user = nextUser();
    // CNY 侧只测小额（共享 outside 科目不能被推到 numeric 上限）
    const ok = ['0.000000000000000001', '007', '0.5000', '1'];
    for (const [i, amount] of ok.entries()) {
      await wallet.credit({
        userId: user,
        amount,
        refType: 'topup',
        refId: `${ref(user, 'fmt')}-${i}`,
      });
    }
    // 20 位整数上限在独立币种验证（隔离科目，单笔恰好到达 numeric(38,18) 天花板）
    await wallet.credit({
      userId: user,
      currency: 'XAU',
      amount: '99999999999999999999',
      refType: 'topup',
      refId: ref(user, 'max'),
    });
    expect(sameAmount(await wallet.balance(user, 'XAU'), '99999999999999999999')).toBe(true);
    const bad = [
      '0',
      '-5',
      '-0',
      '+1',
      '.5',
      '5.',
      '1e3',
      '1E3',
      'NaN',
      'Infinity',
      '',
      ' 5',
      '5 ',
      'abc',
      '0.0000000000000000001', // 19 位小数
      '999999999999999999999', // 21 位整数
      '1; DROP TABLE wallet_accounts',
      '1 OR 1=1',
    ];
    for (const amount of bad) {
      await expect(
        wallet.credit({ userId: user, amount, refType: 'topup', refId: 'x' }),
        `amount=${JSON.stringify(amount)} 应被拒绝`,
      ).rejects.toThrow();
    }
    // 合法前导零/尾零归一：'007' 存储后 replay 返回 '7'
    const replay = await wallet.credit({
      userId: user,
      amount: '7',
      refType: 'topup',
      refId: `${ref(user, 'fmt')}-1`,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.amount).toBe('7');
  });

  it('精度安全：0.1 + 0.2 精确为 0.3（无 IEEE 浮点误差）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '0.1', refType: 'topup', refId: ref(user, 'a') });
    await wallet.credit({ userId: user, amount: '0.2', refType: 'topup', refId: ref(user, 'b') });
    expect(sameAmount(await wallet.balance(user), '0.3')).toBe(true);
  });

  it('词表边界：refId 128 字符恰好、129 拒绝；refType 大写/连字符拒绝；memo 256 拒绝', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: 'x'.repeat(128) });
    await expect(
      wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: 'x'.repeat(129) }),
    ).rejects.toThrow();
    // 'constructor' 等普通英文词按 snake_case 合法接受（参数化存储，无原型风险），不在此列
    for (const refType of ['Order', 'ORDER-X', 'order x', "'; DROP--", '__proto__', '1order']) {
      await expect(
        wallet.credit({ userId: user, amount: '1', refType, refId: 'x' }),
        `refType=${refType} 应被拒绝`,
      ).rejects.toThrow();
    }
    await expect(
      wallet.credit({
        userId: user,
        amount: '1',
        refType: 'topup',
        refId: 'y',
        memo: 'm'.repeat(256),
      }),
    ).rejects.toThrow();
  });

  it('userId 边界：0 / 负数 / 非整数拒绝，无状态残留', async () => {
    for (const userId of [0, -5, 1.5]) {
      await expect(
        wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'x' }),
        `userId=${userId} 应被拒绝`,
      ).rejects.toThrow();
    }
  });

  it('expiresAt 为过去时间：authorize 成功但首轮扫描即释放', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '10',
      refType: 'order',
      refId: ref(user, 'past'),
      expiresAt: new Date(Date.now() - 60_000),
    });
    await walletMaintenance.releaseExpired(); // 计数不断言：并行文件扫描器可能先抢
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('恰好的边界金额：余额恰好冻结成功、结算恰好等于冻结额', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '10',
      refType: 'order',
      refId: ref(user, 'exact'),
    });
    const settled = await wallet.settle({
      refType: 'order',
      refId: ref(user, 'exact'),
      amount: '10',
    });
    expect(sameAmount(settled.balanceAfter, '0')).toBe(true);
    expect(sameAmount(settled.releasedRemainder, '0')).toBe(true);
  });
});
