/**
 * E2E ⑮ 慢上游三形态实测：慢生成非流式（响应头晚到）/ 慢生成流式（首字节后长流）/
 * 计费租约 vs 长流时长。回答「上游本身很慢会有问题吗」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2EKeys, E2E_MODEL, e2eDb, e2ePost, startE2EGateway, type E2EGateway } from './e2e-kit.js';

const db = e2eDb();
const keys = new E2EKeys(db);
let gateway: E2EGateway;
let restoreBudget: () => Promise<void>;

beforeAll(async () => {
  // ⑮a 验证慢上游旋钮：connect 预算放宽到 60s（默认 10s 会误杀 20s+ 的非流式生成）
  gateway = await startE2EGateway(db, { GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: 60_000 });
  restoreBudget = await keys.snapshotChannelBudget(2);
}, 30_000);

afterAll(async () => {
  await restoreBudget();
  await keys.cleanup();
  await gateway.stop();
  await db.$client.end().catch(() => {});
});

describe('E2E ⑮ 慢上游三形态', () => {
  it('慢生成非流式（3000 字）：connect 预算放宽后照常完成并计费（默认 10s 会误杀）', async () => {
    const { raw, userId } = await keys.issue('1');
    const t0 = Date.now();
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 20_000,
      messages: [{ role: 'user', content: '写一篇 3000 字的散文，主题：海' }],
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`⑮a 非流式 3000 字（connect=60s）：${elapsed}s → ${res.status}`);
    expect(res.status).toBe(200); // 旋钮生效：上游 22s 的生成不再被 10s 误杀
    await res.text();
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(1);
    expect(bills[0]!.status).toBe('settled');
    await keys.assertReconciled(userId, '1'); // 慢但照实计费
  }, 180_000);

  it('慢生成流式（长思考长输出）：透传全程 + 尾帧 usage 照实计费', async () => {
    const { raw, userId } = await keys.issue('1');
    const t0 = Date.now();
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, stream: true, max_tokens: 20_000,
      messages: [{ role: 'user', content: '写一篇 2000 字的散文，主题：山' }],
    });
    console.log(`⑮b 流式首响应 ${res.status} @ ${Date.now() - t0}ms`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`⑮b 流式全程 ${elapsed}s，转发 ${text.length} 字节`);
    expect(text.length).toBeGreaterThan(500);

    await new Promise((r) => setTimeout(r, 2_000));
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(1);
    await keys.assertReconciled(userId, '1');
  }, 180_000);
});
