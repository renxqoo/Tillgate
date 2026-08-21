/**
 * E2E 对抗套件（真网关 + 平台 key + 真上游）——攻击 / 资损 / 漏扣 / 多扣 / 扣错全向量：
 *
 *   ⑤ 非法请求全家族（坏 key/坏体/未知模型/负参数/超大体/SQL 注入模型名）→ 全部零扣费
 *   ⑥ 伪造 x-request-id → 服务端 ID 独立（账单不混淆、不可固定绕过）
 *   ⑦ 非流式断连 → 单笔账单有始有终（不漏扣已产生输出）
 *   ⑧ 取消风暴（6 路并发流交错取消）→ 账单数 == 请求数、分毫对账
 *   ⑨ stream/非 stream 混合并发 → 收据旗标正确、usage 与 usage_logs 逐笔一致
 *   ⑩ n 倍数请求（或上游不支持 → 释放不扣）→ 资金一致两分支
 *
 * 无法在本地确定性复现、由集成/单测层覆盖的向量（见文件尾覆盖矩阵）：
 *   Redis 两层爆破防护、免费模型日限、§4 超额补充授权、上游故障注入换渠、
 *   任务双副本并发双结算、流式终态 double-fire。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import { E2EKeys, E2E_MODEL, e2eDb, e2ePost, startE2EGateway, type E2EGateway } from './e2e-kit.js';

const db = e2eDb();
const keys = new E2EKeys(db);
let gateway: E2EGateway;
let restoreBudget: () => Promise<void>;

beforeAll(async () => {
  gateway = await startE2EGateway(db);
  restoreBudget = await keys.snapshotChannelBudget(2);
}, 30_000);

afterAll(async () => {
  await restoreBudget();
  await keys.cleanup();
  await gateway.stop();
  await db.$client.end().catch(() => {});
});

describe('E2E 对抗 · 非法请求全家族零扣费', () => {
  it('⑤ 坏 key 401 / 坏体 400 / 未知模型 404 / 负参数 400 / SQL 注入模型名 404 → 账单零落', async () => {
    const { raw, userId } = await keys.issue('1');

    const attempts = await Promise.all([
      e2ePost(gateway.baseUrl, 'ag_invalidinvalidinvalid', { model: E2E_MODEL, messages: [{ role: 'user', content: 'x' }] }),
      e2ePost(gateway.baseUrl, raw, { model: E2E_MODEL }).catch((e) => e as Error), // 缺 messages → 400
      e2ePost(gateway.baseUrl, raw, { model: `no-such-model-${randomUUID().slice(0, 6)}`, messages: [{ role: 'user', content: 'x' }] }),
      e2ePost(gateway.baseUrl, raw, { model: E2E_MODEL, max_tokens: -5, messages: [{ role: 'user', content: 'x' }] }),
      e2ePost(gateway.baseUrl, raw, { model: `RX-M3'; drop table users;--`, messages: [{ role: 'user', content: 'x' }] }),
    ]);
    const statuses = attempts.map((a) => (a instanceof Error ? 'throw' : String(a.status)));
    expect(statuses[0]).toBe('401');
    expect(['400', 'throw']).toContain(statuses[1]);
    expect(statuses[2]).toBe('404');
    expect(statuses[3]).toBe('400');
    expect(statuses[4]).toBe('404'); // 注入串按「未知模型」处理，无副作用

    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(0); // 全家族零扣费（鉴权/校验失败不产生任何账单行）
    const walletState = await keys.walletOf(userId);
    expectDecimal(walletState.balance, '1');
  }, 60_000);

  it('⑤b 超大请求体 413 → 零扣费', async () => {
    const { raw, userId } = await keys.issue('1');
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: E2E_MODEL, messages: [{ role: 'user', content: 'A'.repeat(11 * 1024 * 1024) }] }), // 默认上限 10MiB
    });
    expect(res.status).toBe(413);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(0);
  }, 30_000);
});

describe('E2E 对抗 · 身份与幂等', () => {
  it('⑥ 伪造 x-request-id 连发 → 服务端各自生成：两笔独立账单不可混淆', async () => {
    const { raw, userId } = await keys.issue('1');
    const forged = randomUUID();
    const [a, b] = await Promise.all([
      fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json', 'x-request-id': forged },
        body: JSON.stringify({ model: E2E_MODEL, max_tokens: 100, messages: [{ role: 'user', content: '只回复：一' }] }),
      }),
      fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json', 'x-request-id': forged },
        body: JSON.stringify({ model: E2E_MODEL, max_tokens: 100, messages: [{ role: 'user', content: '只回复：二' }] }),
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get('x-request-id')).not.toBe(forged);
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));

    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(2); // 两笔独立（若信任伪造头会撞幂等键）
    const reconciled = await keys.assertReconciled(userId, '1');
    expect(new Decimal(reconciled.charged).gt(0)).toBe(true);
  }, 120_000);

  it('⑦ 非流式断连（响应未读即弃）→ 单笔账单、结算不漏（已产生输出照实计费）', async () => {
    const { raw, userId } = await keys.issue('1');
    const ac = new AbortController();
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 200, messages: [{ role: 'user', content: '写 100 字' }],
    }, ac.signal);
    expect(res.status).toBe(200);
    ac.abort(); // 拿到响应头即断（不读体）
    await res.body?.cancel().catch(() => {});

    await new Promise((r) => setTimeout(r, 2_000));
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(1);
    expect(bills[0]!.status).toBe('settled');
    await keys.assertReconciled(userId, '1'); // 分毫对账（断连不等于免费）
  }, 120_000);
});

describe('E2E 对抗 · 并发取消与混合负载', () => {
  it('⑧ 取消风暴：6 路并发流交错取消 → 恰 6 笔账单、分毫对账、在途归零', async () => {
    const FUND = '1';
    const { raw, userId } = await keys.issue(FUND);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const launches = controllers.map((ac, i) =>
      e2ePost(gateway.baseUrl, raw, {
        model: E2E_MODEL, stream: true, max_tokens: 300,
        messages: [{ role: 'user', content: `从 1 慢慢数到 30（第 ${i} 批）` }],
      }, ac.signal).then(async (res) => {
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        await reader.read(); // 至少一帧输出
        await new Promise((r) => setTimeout(r, 150 * (i + 1))); // 交错取消点
        ac.abort();
        await reader.cancel().catch(() => {});
        return true;
      }),
    );
    const survived = await Promise.all(launches.map((p) => p.then(() => 'ok', () => 'err')));
    expect(survived.every((s) => s === 'ok')).toBe(true);

    await new Promise((r) => setTimeout(r, 3_000)); // 终态收敛
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(6); // 每次取消恰一笔（不因取消产生额外/缺失账单）
    const reconciled = await keys.assertReconciled(userId, FUND);
    expect(new Decimal(reconciled.charged).gt(0)).toBe(true); // 已产生输出全部计费（不漏扣）
  }, 240_000);

  it('⑨ stream/非 stream 混合并发 4+4 → 旗标正确、收据 usage == usage_logs 逐笔一致', async () => {
    const FUND = '1';
    const { raw, userId } = await keys.issue(FUND);
    const jobs = [
      ...Array.from({ length: 4 }, () =>
        e2ePost(gateway.baseUrl, raw, { model: E2E_MODEL, stream: true, max_tokens: 150, messages: [{ role: 'user', content: '只回复：流' }] })
          .then(async (res) => { expect(res.status).toBe(200); await res.text(); return 'stream'; })),
      ...Array.from({ length: 4 }, () =>
        e2ePost(gateway.baseUrl, raw, { model: E2E_MODEL, max_tokens: 150, messages: [{ role: 'user', content: '只回复：非流' }] })
          .then(async (res) => { expect(res.status).toBe(200); await res.text(); return 'plain'; })),
    ];
    const kinds = await Promise.all(jobs);
    expect(kinds.filter((k) => k === 'stream').length).toBe(4);

    await new Promise((r) => setTimeout(r, 2_000));
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(8);
    // 收据旗标与请求形态一致（不串）
    const streamFlags = bills.map((b) => (b.receipt as { stream?: boolean } | null)?.stream === true);
    expect(streamFlags.filter(Boolean).length).toBe(4);
    // 逐笔一致：收据 token 与 usage_logs 行 token 完全相等（不多算不少算）
    const logs = await db.$client.query<{ request_id: string; input_tokens: string; output_tokens: string }>(
      'select request_id, input_tokens::text, output_tokens::text from usage_logs where user_id = $1', [userId],
    );
    expect(logs.rows.length).toBe(8);
    for (const bill of bills) {
      const log = logs.rows.find((l) => l.request_id === bill.request_id);
      expect(log).toBeDefined();
      const usage = (bill.receipt as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
      expect(String(usage?.inputTokens ?? 0)).toBe(log!.input_tokens);
      expect(String(usage?.outputTokens ?? 0)).toBe(log!.output_tokens);
    }
    await keys.assertReconciled(userId, FUND);
  }, 240_000);

  it('⑩ n 倍数（输出上界 ×n）：成功则计费覆盖全部输出；上游不支持则释放不扣——两分支资金都一致', async () => {
    const FUND = '1';
    const { raw, userId } = await keys.issue(FUND);
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 100, n: 3, messages: [{ role: 'user', content: '只回复：好' }],
    });
    // 分支一：上游接受 n → 200 计费；分支二：上游拒绝 → 502 三路归还
    if (res.status === 200) {
      await res.text();
      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(1);
      expect(bills[0]!.status).toBe('settled');
      await keys.assertReconciled(userId, FUND);
    } else {
      expect([400, 502]).toContain(res.status);
      await res.text();
      await new Promise((r) => setTimeout(r, 1_500));
      const bills = await keys.billsOf(userId);
      expect(bills.every((b) => b.status === 'released')).toBe(true);
      await keys.assertReconciled(userId, FUND); // 释放后 charged=0，余额==充值
    }
  }, 120_000);
});

function expectDecimal(actual: string, expected: string): void {
  expect(new Decimal(actual).eq(expected)).toBe(true);
}

/**
 * ┌ 覆盖矩阵：向量 → 测试落点 ┐
 * │ 漏扣-流式取消         → e2e ⑧ 取消风暴（6 笔全计费）+ ①（e2e-rxm3）
 * │ 漏扣-非流式断连       → e2e ⑦
 * │ 漏扣-上游失败         → e2e ④（18×200+2×502 未扣）+ 冒烟「错密钥 502 释放」
 * │ 多扣-取消重复计费     → e2e ① 单笔断言 + double-fire 单测（pipeline）
 * │ 多扣-usage 放大/串账  → e2e ⑨ 收据==usage_logs 逐笔 + ④ 分毫对账
 * │ 多扣-幂等键碰撞       → e2e ⑥ 伪造 x-request-id 独立两笔
 * │ 扣错-跨用户归属       → e2e ④（5 用户）+ 集成归属测试
 * │ 资损-低余额并发放大   → e2e ③（放行 4/拒 4，亏损 ≤ 单笔级）+ 集成 §4
 * │ 攻击-爆破/刷 401      → 单测（production-hardening 两层防护）＊需 Redis 生产形态
 * │ 攻击-免费模型刷       → 单测 fail-closed（gate.test）＊同上
 * │ 攻击-SSRF/IP 伪造     → ai 包 http-client 单测 + http 包 trustedClientIp 7 例
 * │ 攻击-SQL 注入         → e2e ⑤ 注入模型名 404 零副作用 + 架构测试（SQL 只在 drizzle 层）
 * │ 攻击-超大体/负参数    → e2e ⑤/⑤b 400/413 零扣费
 * │ 资损-任务双结算       → 集成（generation-poll 并发 CAS 单赢家）
 * │ 资损-§4 超额推负      → 集成（settlement over-hold 精确补押）——真上游无法确定性触发
 * └────────────────────────┘
 */
