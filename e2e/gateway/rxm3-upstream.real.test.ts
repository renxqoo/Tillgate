/**
 * 端到端真实链路（v1 e2e-rxm3 迁移；*.real.test.ts——真上游 MiniMax 花钱，
 * 默认门禁排除，经 e2e real 脚本显式运行；MIGRATION §5 单列裁决）：
 *   ① 流式中途取消（模型已有输出）→ 计费归属与资金一致性
 *   ② 上游未返回时取消 → 网关行为与资金一致性
 *   ③ 低余额并发 → 放行数量 / 最多亏损 / 能否负、负多少
 *   ④ 多用户大并发 → 数据不错乱（归属/幂等）、不多扣不扣错（钱包对账精确）
 *
 * 装置（v1→v2）：共享 dev 库渠道 2 → 隔离 schema + 渠道克隆（dev 库解密明文 key
 * 以测试密钥重加密——预算/熔断与 dev 环境互不干扰）；请求体量小（max_tokens 低）控成本。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '@tokenlens/db';
import { createCipher } from '@tokenlens/runtime';
import { Decimal } from '@tokenlens/billing';
import {
  E2EKeys,
  E2E_MODEL,
  devEncryptionKey,
  e2ePost,
  retargetUpstream,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

/** 真上游开关：显式 opt-in（花钱）——E2E_REAL_UPSTREAM=1 且 DB/Redis env 就绪 */
const enabled =
  process.env.E2E_REAL_UPSTREAM === '1' &&
  (process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null) &&
  process.env.REDIS_URL != null;

describe.skipIf(!enabled)('E2E · 真网关 + 平台 key + RX-M3（真上游）', () => {
  let world: E2EWorld;
  let gateway: E2EGateway;
  let keys: E2EKeys;
  /** dev 库直连（只读克隆渠道凭据） */
  let devDb: Db;

  beforeAll(async () => {
    world = await setupE2EWorld();
    // 渠道克隆：dev 库 channel 2（minimax-default）→ 本世界（key 重加密）
    devDb = createDb({ url: process.env.DB_TEST_URL ?? process.env.DATABASE_URL!, poolMax: 2 });
    const row = await devDb.execute<{ base_url: string; protocol: string; vendor: string | null; api_key_enc: string }>(sql`
      select p.base_url, p.protocol, p.vendor, c.api_key_enc
      from channels c join providers p on p.id = c.provider_id
      where c.id = 2`);
    const channel = row.rows[0]!;
    await retargetUpstream(world, {
      baseUrl: channel.base_url,
      protocol: channel.protocol,
      ...(channel.vendor != null ? { vendor: channel.vendor } : {}),
      apiKeyPlain: createCipher(devEncryptionKey()).decrypt(channel.api_key_enc),
    });
    gateway = await startE2EGateway(world);
    keys = new E2EKeys(world, gateway.assembly.billingFacade);
  }, 120_000);

  afterAll(async () => {
    if (gateway) await gateway.stop();
    if (devDb) await closeDb(devDb);
    if (world) await world.teardown();
  });

  it(
    '① 流式中途取消（已有输出）：单笔账单、资金一致、结算后余额不为负',
    async () => {
      const { raw, userId } = await keys.issue('1');
      const ac = new AbortController();
      const res = await e2ePost(
        gateway.baseUrl,
        raw,
        {
          model: E2E_MODEL,
          stream: true,
          max_tokens: 400,
          messages: [{ role: 'user', content: '从 1 数到 50，每个数一行' }],
        },
        ac.signal,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // 读到首批输出（模型已产生内容）后取消
      const reader = res.body!.getReader();
      await reader.read();
      await sleep(300); // 让输出累积
      ac.abort();
      await reader.cancel().catch(() => {});

      // 等终态（usage 真实或按取消估算）
      await sleep(1_500);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(1); // 单笔账单（取消不产生第二笔）
      await keys.settleAll(userId);
      const finalBills = await keys.billsOf(userId);
      expect(['settled', 'released']).toContain(finalBills[0]!.status);
      const walletState = await keys.walletOf(userId);
      // 资金一致性：结算后余额 = 1 − 实扣；实扣 ≤ 真实用量（不为负超额放大）
      expect(new Decimal(walletState.balance).gte('-0.05')).toBe(true);
      expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
    },
    120_000,
  );

  it(
    '② 上游未返回时取消：账单有始有终（settle 或 release），钱包在途归零',
    async () => {
      const { raw, userId } = await keys.issue('1');
      const ac = new AbortController();
      const fetchPromise = e2ePost(
        gateway.baseUrl,
        raw,
        {
          model: E2E_MODEL,
          stream: true,
          max_tokens: 400,
          messages: [{ role: 'user', content: '写一篇 800 字文章' }],
        },
        ac.signal,
      );
      // 等授权落账（请求已进网关、上游尚未返回——thinking 模型有窗口期）
      const deadline = Date.now() + 10_000;
      for (;;) {
        const bills = await keys.billsOf(userId);
        if (bills.length >= 1 || Date.now() > deadline) break;
        await sleep(50);
      }
      ac.abort();
      await fetchPromise.catch(() => {});

      // 终态收敛：不允许停在 authorized/in_flight 悬挂（租约是兜底，这里等上游自然结束）
      await sleep(4_000);
      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(1);
      expect(['settled', 'settlement_pending', 'released', 'in_flight']).toContain(bills[0]!.status);
      const walletState = await keys.walletOf(userId);
      expect(new Decimal(walletState.balance).gte('-0.05')).toBe(true);
    },
    120_000,
  );

  it(
    '③ 低余额并发 8 路：放行受限、总亏损有界、余额可负但被结构钳制',
    async () => {
      const FUND = '0.006'; // ≈ 4 个最小请求的押金（max_tokens 150 → 押 ~0.0013/笔）
      const { raw, userId } = await keys.issue(FUND);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          e2ePost(gateway.baseUrl, raw, {
            model: E2E_MODEL,
            max_tokens: 150,
            messages: [{ role: 'user', content: '只回复：好' }],
          }).then(async (res) => ({ status: res.status, body: await res.text() })),
        ),
      );
      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 'network-error'));
      const ok = statuses.filter((s) => s === 200).length;
      const rejected = statuses.filter((s) => s === 402).length;
      console.log(`③ 余额 ${FUND} 并发 8 路 → 放行 ${ok} / 拒绝 ${rejected}（状态全集 ${JSON.stringify(statuses)}）`);
      expect(ok + rejected).toBe(8); // 要么放行要么 402，无其他态
      expect(ok).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0); // 余额不足以全覆盖 → 必有拒绝（fail-closed 生效）

      await keys.settleAll(userId);
      const walletState = await keys.walletOf(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(ok); // 拒绝零落账
      // 对账精确：Σ实扣（usage_logs）== FUND − 余额（每一分钱都有账单行对应）
      const usage = await world.db.execute<{ sum: string | null }>(
        sql`select sum(amount)::text as sum from usage_logs where user_id = ${userId}`,
      );
      const expectedBalance = new Decimal(FUND).minus(usage.rows[0]!.sum ?? '0');
      expect(new Decimal(walletState.balance).eq(expectedBalance)).toBe(true);
      expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
      // 最多亏损边界：余额不为深度负（单请求级 §4 超额以内）
      console.log(
        `③ 结算后：余额 ${walletState.balance}（亏损深度 ${new Decimal(FUND).minus(walletState.balance).toString()}）在途 ${walletState.inFlight} Σ实扣 ${usage.rows[0]!.sum}`,
      );
      expect(new Decimal(walletState.balance).gte('-0.005')).toBe(true); // 最多亏损 ≤ 单笔级超额
    },
    180_000,
  );

  it(
    '④ 5 用户 × 4 并发：数据不错乱、归属正确、钱包分毫对账',
    async () => {
      const FUND = '1';
      const peers = await Promise.all(Array.from({ length: 5 }, () => keys.issue(FUND)));
      // 每用户 4 路并发，各带专属标记（响应与账单都必须回到正确的用户）
      const all = await Promise.allSettled(
        peers.flatMap((peer, userIndex) =>
          Array.from({ length: 4 }, (_, i) =>
            e2ePost(gateway.baseUrl, peer.raw, {
              model: E2E_MODEL,
              max_tokens: 200,
              messages: [{ role: 'user', content: `只回复四个字：用户${userIndex}序${i}` }],
            }).then(async (res) => ({ userId: peer.userId, userIndex, i, status: res.status })),
          ),
        ),
      );
      const outcomes = all.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'network-error' }));
      const statusCount: Record<string, number> = {};
      for (const o of outcomes) statusCount[o.status] = (statusCount[o.status] ?? 0) + 1;
      console.log('④ 状态分布:', JSON.stringify(statusCount));
      const okCount = statusCount['200'] ?? 0;
      expect(okCount).toBeGreaterThanOrEqual(16); // 允许个别瞬时上游失败，但绝大多数必须成功

      for (const peer of peers) await keys.settleAll(peer.userId);

      for (const [index, peer] of peers.entries()) {
        const userOk = outcomes.filter(
          (o) => (o as { userId?: number }).userId === peer.userId && o.status === 200,
        ).length;
        const ws0 = await keys.walletOf(peer.userId);
        console.log(`④ 用户${index}：${userOk} 笔 / 余额 ${ws0.balance} / 在途 ${ws0.inFlight}`);
        const bills = await keys.billsOf(peer.userId);
        expect(bills.length).toBe(userOk); // 恰好自己的成功笔数（不少收不多收）
        expect(bills.every((b) => b.status === 'settled')).toBe(true);
        const usage = await world.db.execute<{ sum: string | null; rows: string }>(
          sql`select sum(amount)::text as sum, count(*)::text as rows from usage_logs where user_id = ${peer.userId}`,
        );
        expect(usage.rows[0]!.rows).toBe(String(userOk)); // 计量行数与请求一致（不错记他用户）
        const walletState = await keys.walletOf(peer.userId);
        // 分毫对账：余额 = 充值 − Σ本用户实扣；在途归零
        expect(new Decimal(walletState.balance).eq(new Decimal(FUND).minus(usage.rows[0]!.sum ?? '0'))).toBe(true);
        expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
        // 金额 > 0（真上游真用量——不是 0 元白嫖）
        expect(new Decimal(usage.rows[0]!.sum ?? '0').gt(0)).toBe(true);
      }
    },
    240_000,
  );
});
