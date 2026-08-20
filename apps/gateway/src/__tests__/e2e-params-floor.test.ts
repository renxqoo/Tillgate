/**
 * E2E ⑬ 用户参数异常值全家族 + ⑭ fixed 预扣策略并发击穿：
 *   ⑬ 计费预算参数（超大/负/非整数/Infinity 形态的 max_tokens、n 越界）、
 *      结构数量上界（空/超多 messages、embed 批 2049）、边界内超大内容
 *      （9MiB prompt、1e308 采样参数透传）——要么 400 拒绝，要么安全放行且资金一致。
 *   ⑭ 配置「余额 ≥0.1 即放行」的模型上并发 8 路：advice 串行授权 + hold 封顶
 *      实筹 → 击穿不可能；单请求大输出验证最多负债 ≤ 单笔真实用量（§4 上界）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import { E2EKeys, E2E_MODEL, e2eDb, e2ePost, resetChannelBreakers, startE2EGateway, type E2EGateway } from './e2e-kit.js';

const db = e2eDb();
const keys = new E2EKeys(db);
let gateway: E2EGateway;
let restoreBudget: () => Promise<void>;
/** fixed 策略测试模型（绑定同一真上游渠道；测后清理） */
let floorModel = '';
let floorMappingId = 0;

beforeAll(async () => {
  gateway = await startE2EGateway(db, {
    BILLING_RESERVATION_MODE: 'fixed',
    BILLING_FIXED_RESERVATION_AMOUNT: '0.1',
  });
  restoreBudget = await keys.snapshotChannelBudget(2);

  const { modelMappings, modelChannels } = await import('@ai-gateway/db');
  const [mapping] = await db.insert(modelMappings).values({
    externalName: `v2e2e-floor-${randomUUID().slice(0, 8)}`,
    realModel: 'MiniMax-M3', status: 0,
    inputPrice: '2.1', outputPrice: '8.4', cacheInputPrice: '0.42',
  }).returning({ id: modelMappings.id, externalName: modelMappings.externalName });
  floorMappingId = mapping!.id;
  floorModel = mapping!.externalName;
  await db.insert(modelChannels).values({ mappingId: floorMappingId, channelId: 2, priority: 1, weight: 1 });
}, 30_000);

afterAll(async () => {
  await restoreBudget();
  if (floorMappingId) {
    await db.$client.query('delete from model_channels where mapping_id = $1', [floorMappingId]);
    await db.$client.query('delete from model_mappings where id = $1', [floorMappingId]);
  }
  await keys.cleanup();
  await gateway.stop();
  await db.$client.end().catch(() => {});
});

describe('E2E ⑬ 用户参数异常值全家族', () => {
  it('预算参数异常：1e9/Infinity 形态/负数/非整数 max_tokens、n 越界 → 全部 400 零扣费', async () => {
    const { raw, userId } = await keys.issue('1');
    const rawPost = (body: string) =>
      fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body,
      }).then((r) => r.status);
    const msg = JSON.stringify([{ role: 'user', content: 'x' }]);
    const statuses = await Promise.all([
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1000000000}`), // 超 1M 上界
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1e999}`), // JSON 解析为 Infinity
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":-5}`),
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1.5}`), // 非整数
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"n":0}`),
      rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"n":17}`), // 超 16
      rawPost(`{"model":"${E2E_MODEL}","messages":[],"max_tokens":100}`), // 空 messages
      rawPost(`{"model":"${E2E_MODEL}","messages":${JSON.stringify(Array.from({ length: 1001 }, () => ({ role: 'user', content: 'x' })))},"max_tokens":10}`), // 超 1000 条
      fetch(`${gateway.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: E2E_MODEL, input: Array.from({ length: 2049 }, () => 'x') }),
      }).then((r) => r.status), // embed 批超 2048
    ]);
    expect(statuses.every((s) => s === 400)).toBe(true);
    expect((await keys.billsOf(userId)).length).toBe(0); // 全家族零扣费
    expectDecimal((await keys.walletOf(userId)).balance, '1');
  }, 60_000);

  it('边界内超大内容与透传参数：不 5xx、不崩账（9MiB prompt / 1e308 采样参数）', async () => {
    const { raw, userId } = await keys.issue('1');
    const nineMb = '好'.repeat(3 * 1024 * 1024); // 9MiB UTF-8（< 10MiB 体上限）
    const giant = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 50, messages: [{ role: 'user', content: nineMb }],
    }).then((r) => String(r.status)).catch(() => 'network-error');
    const sampled = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 50, temperature: 1e308, top_p: 1e-320,
      messages: [{ role: 'user', content: '只回复：好' }],
    }).then((r) => String(r.status)).catch(() => 'network-error');

    // 允许 200（安全放行并计费）或 4xx/502（上游/校验拒绝）——网关不允许 5xx 崩溃
    for (const status of [giant, sampled]) {
      expect(['200', '400', '402', '413', '502', 'network-error']).toContain(status);
      // 500（网关自身崩溃）不允许；502（上游拒绝/失败）是合法终态
      expect(status === '500').toBe(false);
    }
    await new Promise((r) => setTimeout(r, 2_000));
    await keys.settleAll(userId);
    await keys.assertReconciled(userId, '1'); // 放行的都正确计费，拒绝的零扣
    // 9MiB 真上游 5xx 会打开渠道熔断（5 分钟冷却）——不清掉会连坐 ⑭ 的放行用例
    await resetChannelBreakers();
  }, 180_000);
});

describe('E2E ⑭ fixed=0.1 并发击穿验证', () => {
  // 真上游的长生成/重试失败会打开渠道熔断（全局状态，5 分钟冷却）——
  // ⑭ 验证的是计费放行语义而非渠道韧性，每例前复位熔断保证起点干净
  beforeEach(async () => {
    await resetChannelBreakers();
  });

  it('余额 0.15 并发 8 路：至多 1-2 路放行（首路押尽可用额），其余 402；零击穿', async () => {
    const FUND = '0.15';
    const { raw, userId } = await keys.issue(FUND);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        e2ePost(gateway.baseUrl, raw, {
          // 大 max_tokens：保守估价 ≈0.168 > 余额 0.15，但 fixed 只冻结 0.1。
          model: floorModel, max_tokens: 20_000, messages: [{ role: 'user', content: '只回复：好' }],
        }).then((r) => r.status),
      ),
    );
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value : 'network-error'));
    const ok = statuses.filter((s) => s === 200).length;
    const rejected = statuses.filter((s) => s === 402).length;
    console.log(`⑭ 并发 8 路 → 放行 ${ok} / 402 ${rejected}（fixed 0.1，余额 ${FUND}）`);
    expect(ok).toBeLessThanOrEqual(1); // 串行授权 + 固定冻结：首路后可用 0.05，余路拒绝
    expect(ok + rejected).toBe(8);

    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(ok); // 拒绝零落账
    const { balance } = await keys.assertReconciled(userId, FUND);
    expect(new Decimal(balance).gte('-0.01')).toBe(true); // 无击穿：不产生超出单笔的负债
  }, 240_000);

  it('单路大输出（max_tokens 20000）：最多负债 = 该笔真实用量（§4 上界内）', async () => {
    const FUND = '0.1';
    const { raw, userId } = await keys.issue(FUND);
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: floorModel, max_tokens: 20_000,
      messages: [{ role: 'user', content: '写一篇 500 字的短文，主题：海' }],
    });
    // 200（放行计费）或 502（上游超时三路归还）都是合法终态——两分支资金必须一致
    expect([200, 502]).toContain(res.status);
    await res.text().catch(() => {});

    await new Promise((r) => setTimeout(r, 2_000));
    await keys.settleAll(userId);
    const { balance } = await keys.assertReconciled(userId, FUND);
    // 上界：input(小) + 20000×8.4/M ≈ 0.168+ ——负债不可能超过该笔真实用量
    console.log(`⑭ 大输出结算后余额 ${balance}（负债 ${new Decimal(FUND).minus(balance).abs().toString()}）`);
    expect(new Decimal(balance).gte('-0.18')).toBe(true); // 单笔 §4 上界（20000 token 封顶）
    const bills14 = await keys.billsOf(userId);
    expect(bills14.length).toBe(1);
    expect(['settled', 'released']).toContain(bills14[0]!.status);
  }, 240_000);

  it('结算后连环放行：可用余额仍 ≥ fixed 即可再来——累计扣款恒等于真实用量', async () => {
    const FUND = '0.12';
    const { raw, userId } = await keys.issue(FUND);
    for (let round = 0; round < 3; round++) {
      const res = await e2ePost(gateway.baseUrl, raw, {
        model: floorModel, max_tokens: 150, messages: [{ role: 'user', content: '只回复：好' }],
      });
      expect(res.status).toBe(200); // 每轮余额仍 ≥ 0.1 → 放行
      await res.text();
      await keys.settleAll(userId);
      const { balance } = await keys.assertReconciled(userId, FUND);
      expect(new Decimal(balance).gte(FUND === '0.12' ? '0.11' : '0')).toBe(true); // 小额实扣
      void balance;
    }
    // 3 轮总亏损 = Σ真实用量（≈3×0.0005），余额仍在 floor 之上——薅不成羊毛
    const finalState = await keys.walletOf(userId);
    expect(new Decimal(finalState.balance).gt('0.118')).toBe(true);
  }, 300_000);
});

function expectDecimal(actual: string, expected: string): void {
  expect(new Decimal(actual).eq(expected)).toBe(true);
}
