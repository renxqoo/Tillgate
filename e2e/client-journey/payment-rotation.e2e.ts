/**
 * 支付验签密钥轮换双读窗 E2E（docs/integration-settings/DESIGN.md §5 D6 收口项）：
 * 密钥轮换后，窗口内旧 key 签名的回调仍验签归账（在途订单不丢）；
 * 窗口外旧 key 拒收、新 key 恒通。全链 = client-api 动态包装层 → 快照
 * verifyKeys → billing 验签序列（协议面矩阵在 packages/billing 单测）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@tillgate/billing';
import {
  apiClient,
  bootHarness,
  cleanupSeeds,
  cleanupUsers,
  infraReady,
  reservePort,
  sendEpayNotify,
  walletBalance,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

/** 双读窗宽（与 control-plane domain 常量同值——96h） */
const WINDOW_MS = 96 * 60 * 60 * 1000;
const OLD_KEY = 'e2e-old-epay-key';

interface Journey {
  h: E2eHarness;
  api: ReturnType<typeof apiClient>;
  token: string;
  userId: number;
  email: string;
}

const journeys: Journey[] = [];

/** 单旅程装配：boot（带轮换种子）→ 注册两步制（captureMailer 截获验证码） */
async function bootRotatedJourney(rotatedAgoMs: number): Promise<Journey> {
  const port = await reservePort();
  const h = await bootHarness({
    appPort: port,
    epayRotation: { previousKey: OLD_KEY, rotatedAgoMs },
  });
  const api = apiClient(h.baseUrl);
  const email = `e2e-rot-${Date.now().toString(36)}-${journeys.length}@example.com`;
  const reg = await api('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'rotation-password-123' }),
  });
  const regBody = (await reg.json()) as { challengeId: string };
  const ver = await api('/v1/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: regBody.challengeId, code: h.mailer.lastCodeOf(email) }),
  });
  const verBody = (await ver.json()) as { token: string; userId: number };
  const journey: Journey = { h, api, token: verBody.token, userId: verBody.userId, email };
  journeys.push(journey);
  return journey;
}

/** 下单并返回订单号（金额 10） */
async function createTopup(j: Journey): Promise<string> {
  const order = (await (
    await j.api('/v1/payments/orders', {
      method: 'POST',
      token: j.token,
      body: JSON.stringify({ amount: '10', provider: 'epay' }),
    })
  ).json()) as { orderId: string };
  return order.orderId;
}

afterAll(async () => {
  for (const j of journeys) {
    await cleanupUsers(j.h.assembly.db, [{ id: j.userId, email: j.email }]);
    await cleanupSeeds(j.h.assembly.db);
    await j.h.teardown();
  }
});

context('epay 验签密钥轮换双读窗（全链）', () => {
  it('窗口内：旧 key 签名回调仍归账（在途订单不因轮换丢失）', async () => {
    const j = await bootRotatedJourney(WINDOW_MS - 60 * 60 * 1000); // 1h 前轮换
    const orderId = await createTopup(j);
    const before = new Decimal(await walletBalance(j.api, j.token));

    const oldKeyNotify = await sendEpayNotify(j.api, {
      epay: { pid: j.h.epay.pid, key: OLD_KEY },
      orderId,
      money: '10',
    });
    expect(oldKeyNotify.text).toBe('success');
    const detail = (await (
      await j.api(`/v1/payments/orders/${orderId}`, { token: j.token })
    ).json()) as { status: number };
    expect(detail.status).toBe(2); // 已入账
    expect(new Decimal(await walletBalance(j.api, j.token)).minus(before).toString()).toBe('10');
  });

  it('窗口外：旧 key 拒收不入账；新 key 恒通', async () => {
    const j = await bootRotatedJourney(WINDOW_MS + 60 * 1000); // 窗口外 1 分钟
    const orderId = await createTopup(j);
    const before = new Decimal(await walletBalance(j.api, j.token));

    const oldKeyNotify = await sendEpayNotify(j.api, {
      epay: { pid: j.h.epay.pid, key: OLD_KEY },
      orderId,
      money: '10',
    });
    expect(oldKeyNotify.text).toBe('fail'); // 窗口外旧签名拒收
    expect(new Decimal(await walletBalance(j.api, j.token)).toString()).toBe(before.toString());

    const newKeyNotify = await sendEpayNotify(j.api, {
      epay: { pid: j.h.epay.pid, key: j.h.epay.key },
      orderId,
      money: '10',
    });
    expect(newKeyNotify.text).toBe('success');
    expect(new Decimal(await walletBalance(j.api, j.token)).minus(before).toString()).toBe('10');
  });
});
