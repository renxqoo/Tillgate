/**
 * E2E ④ 跨 app 全链（client-api + gateway 双真服务 + 真上游 RX-M3）：
 * HTTP 注册 → epay 充值 → HTTP 开 Key → 真网关鉴权调用 → 结算 →
 * client-api 用量/钱包/订单三面读数对账 → 吊销 Key 立即阻断网关。
 * 这是「用户从注册到消费」的最长真链——两 app 只共享同一 dev 库（生产拓扑）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import {
  E2EFixtures,
  e2eDb,
  expectAmountEq,
  http,
  signedEpayNotify,
  startClientApi,
  type E2EClientApi,
} from './e2e-kit.js';
// 跨 app 复用 gateway 的 E2E 基建（真网关装配 + 平台对账工具）
import { E2EKeys, e2ePost, startE2EGateway, E2E_MODEL, type E2EGateway } from '../../../gateway/src/__tests__/e2e-kit.js';

let api: E2EClientApi;
let gateway: E2EGateway;
let fx: E2EFixtures;
let ledger: E2EKeys;

beforeAll(async () => {
  const db = e2eDb();
  api = await startClientApi(db);
  gateway = await startE2EGateway(db);
  fx = new E2EFixtures(db);
  ledger = new E2EKeys(db);
}, 120_000);

afterAll(async () => {
  await ledger.cleanup();
  await fx.cleanup();
  await api.stop();
  await gateway.stop();
  await api.db.$client.end().catch(() => {});
});

describe('E2E ④ 跨 app 全链（注册 → 充值 → 开 Key → 网关消费 → 对账 → 吊销）', () => {
  it('注册 + 充值 + 开 Key → 网关 /v1/models 鉴权通过', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    // 充值 20（真 epay 回调）
    const order = await http(api.baseUrl, 'POST', '/v1/payments/orders', {
      token: user.token,
      body: { amount: '20' },
    });
    const { orderId } = order.body as { orderId: string };
    const notify = await http(api.baseUrl, 'POST', '/v1/payments/notify/epay', {
      contentType: 'application/x-www-form-urlencoded',
      body: signedEpayNotify(orderId, '20'),
    });
    expect(notify.text).toBe('success');

    // 开 Key（走用户面，不落明文）
    const keyRes = await http(api.baseUrl, 'POST', '/v1/keys', {
      token: user.token,
      body: { name: 'cross-app-key' },
    });
    expect(keyRes.status).toBe(201);
    const key = keyRes.body as { id: number; plaintext: string };

    // 真网关：Key 鉴权（/v1/models 是鉴权面烟囱——不触发计费）
    const models = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(models.status).toBe(200);

    // 持有引用给后续用例
    context.user = user;
    context.key = key;
  });

  it('真上游消费（RX-M3 小请求）→ 结算 → client-api 三面读数与网关对账一致', async () => {
    const { user } = context;
    // 小请求控成本：max_tokens=16、一句话
    const chat = await e2ePost(gateway.baseUrl, context.key.plaintext, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '回复：好' }],
      max_tokens: 16,
      stream: false,
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as { usage?: { total_tokens?: number } };
    expect(chatBody.usage).toBeTruthy();

    // 驱动结算（worker 的正确性兜底路径——E2E 直接认领）
    await ledger.settleAll(user.userId);
    // 强对账：余额 == 20 − Σ实扣；在途 0
    const { charged } = await ledger.assertReconciled(user.userId, '20');
    expect(new Decimal(charged).greaterThan(0)).toBe(true);

    // client-api 用量面：明细/按模型都能看到这笔（billedBy=payg，keyName 是用户起的名）
    const usage = await http(api.baseUrl, 'GET', '/v1/usage', { token: user.token });
    const rows = (usage.body as {
      rows: { externalModel: string; billedBy: string; amount: string; keyName: string | null }[];
    }).rows;
    const row = rows.find((r) => r.externalModel === E2E_MODEL);
    expect(row).toBeTruthy();
    expect(row!.billedBy).toBe('payg');
    expect(row!.keyName).toBe('cross-app-key');
    expectAmountEq(row!.amount, charged); // 用量面金额 == 对账口径 Σ实扣

    const byModel = await http(api.baseUrl, 'GET', '/v1/usage/by-model', { token: user.token });
    const modelRow = (byModel.body as { rows: { model: string; cost: string }[] }).rows.find(
      (r) => r.model === E2E_MODEL,
    );
    expectAmountEq(modelRow!.cost, charged);

    // client-api 钱包面：余额 = 20 − charged（与网关对账同一数字）
    expectAmountEq(await fx.balanceOf(user.userId), new Decimal('20').minus(charged).toString());
  });

  it('吊销 Key（用户面）→ 网关立即 401（同库同源，无缓存窗口）', async () => {
    const revoked = await http(api.baseUrl, 'DELETE', `/v1/keys/${context.key.id}`, {
      token: context.user.token,
    });
    expect(revoked.status).toBe(200);
    const models = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${context.key.plaintext}` },
    });
    expect(models.status).toBe(401);
  });
});

const context: { user: { userId: number; token: string; email: string; password: string }; key: { id: number; plaintext: string } } = {
  user: undefined as never,
  key: undefined as never,
};
