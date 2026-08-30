/**
 * E2E ⑬ 用户参数异常值全家族 + ⑭ fixed 预扣策略并发击穿：
 *   ⑬ 计费预算参数（超大/负/非整数/Infinity 形态的 max_tokens、n 越界）、
 *      结构数量上界（空/超多 messages、embed 批 2049）、边界内超大内容
 *      （9MiB prompt、1e308 采样参数透传）——要么 400 拒绝，要么安全放行且资金一致。
 *   ⑭ 配置「余额 ≥0.1 即放行」的模型上并发 8 路：advice 串行授权 + hold 封顶
 *      实筹 → 击穿不可能；单请求大输出验证最多负债 ≤ 单笔真实用量（单笔上界）。
 * floor 模型种子挂本世界 mock 渠道。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import {
  defined,
  E2EKeys,
  E2E_MODEL,
  e2ePost,
  resetChannelHealth,
  setFixedReservationPolicy,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

// ---------------------------------------------------------------------------
// 模块级断言辅助（it 体内的箭头已处第 4 层回调——max-nested-callbacks 上限 3，
// 统一提为具名函数；断言语义逐条不变）
// ---------------------------------------------------------------------------

const responseStatus = (r: Response): number => r.status;
const statusText = (r: Response): string => String(r.status);
/** 吞取消/清理时的异常（fire-and-forget 清理口径） */
const swallow = (): void => {};
/** 网络层失败折叠标记（⑬ 大内容向量的合法终态之一） */
const networkError = (): string => 'network-error';
/** 超量 messages/embed 批的占位条目（数量上界向量） */
const userMsg = (): { role: string; content: string } => ({ role: 'user', content: 'x' });
const xChar = (): string => 'x';
const is400 = (s: number): boolean => s === 400;
/** settled 结果 → 状态（拒绝折叠为 'network-error'——⑭ 并发击穿断言口径） */
const settledStatus = (r: PromiseSettledResult<number>): number | 'network-error' =>
  r.status === 'fulfilled' ? r.value : 'network-error';
const isOk200 = (s: number | 'network-error'): boolean => s === 200;
const is402 = (s: number | 'network-error'): boolean => s === 402;

describe.skipIf(!hasEnv)('E2E', () => {
  let world: E2EWorld;
  let keys: E2EKeys;
  /** full 缺省网关（⑬）与 fixed=0.1 网关（⑭）——同一世界双预扣策略形态 */
  let fullGateway: E2EGateway;
  let fixedGateway: E2EGateway;
  /** fixed 策略测试模型（绑定同渠道；世界销毁随 schema 级联，无需逐行清理） */
  let floorModel = '';

  beforeAll(async () => {
    world = await setupE2EWorld();
    fullGateway = await startE2EGateway(world);
    // fixed 网关惰性建（⑭ beforeEach）：预扣模式已迁 system_configs KV——
    // env 键已废弃；⑬ full 断言先行，KV 行写入后再装配 fixed 网关
    keys = new E2EKeys(world, fullGateway.assembly.billingFacade);

    const external = `e2e-floor-${randomUUID().slice(0, 8)}`;
    await world.db.execute(sql`
      insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price)
      values (${external}, 'MiniMax-M3', '2.1', '8.4', '0.42')`);
    await world.db.execute(sql`
      insert into model_channels (mapping_id, channel_id, priority, weight, upstream_model)
      select id, ${world.seed.channelId}, 1, 1, real_model from model_mappings where external_name = ${external}`);
    floorModel = external;
  }, 180_000);

  afterAll(async () => {
    if (fixedGateway) await fixedGateway.stop();
    if (fullGateway) await fullGateway.stop();
    if (world) await world.teardown();
  });

  describe('⑬ 用户参数异常值全家族', () => {
    it('预算参数异常：1e9/Infinity 形态/负数/非整数 max_tokens、n 越界 → 全部 400 零扣费', async () => {
      world.upstream.script = 'auto';
      const { raw, userId } = await keys.issue('1');
      const rawPost = (body: string) =>
        fetch(`${fullGateway.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
          body,
        }).then(responseStatus);
      const msg = JSON.stringify([{ role: 'user', content: 'x' }]);
      const statuses = await Promise.all([
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1000000000}`), // 超 1M 上界
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1e999}`), // JSON 解析为 Infinity
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":-5}`),
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"max_tokens":1.5}`), // 非整数
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"n":0}`),
        rawPost(`{"model":"${E2E_MODEL}","messages":${msg},"n":17}`), // 超 16
        rawPost(`{"model":"${E2E_MODEL}","messages":[],"max_tokens":100}`), // 空 messages
        rawPost(
          `{"model":"${E2E_MODEL}","messages":${JSON.stringify(Array.from({ length: 1001 }, userMsg))},"max_tokens":10}`,
        ), // 超 1000 条
        fetch(`${fullGateway.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: E2E_MODEL,
            input: Array.from({ length: 2049 }, xChar),
          }),
        }).then(responseStatus), // embed 批超 2048
      ]);
      expect(statuses.every(is400)).toBe(true);
      expect((await keys.billsOf(userId)).length).toBe(0); // 全家族零扣费
      expect(new Decimal((await keys.walletOf(userId)).balance).eq('1')).toBe(true);
    }, 60_000);

    it('边界内超大内容与透传参数：不 5xx、不崩账（9MiB prompt / 1e308 采样参数）', async () => {
      const { raw, userId } = await keys.issue('1');
      const nineMb = '好'.repeat(3 * 1024 * 1024); // 9MiB UTF-8（< 10MiB 体上限）
      const giant = await e2ePost(fullGateway.baseUrl, raw, {
        model: E2E_MODEL,
        max_tokens: 50,
        messages: [{ role: 'user', content: nineMb }],
      })
        .then(statusText)
        .catch(networkError);
      const sampled = await e2ePost(fullGateway.baseUrl, raw, {
        model: E2E_MODEL,
        max_tokens: 50,
        temperature: 1e308,
        top_p: 1e-320,
        messages: [{ role: 'user', content: '只回复：好' }],
      })
        .then(statusText)
        .catch(networkError);

      // 允许 200（安全放行并计费）或 4xx/502（上游/校验拒绝）——网关不允许 5xx 崩溃
      for (const status of [giant, sampled]) {
        expect(['200', '400', '402', '413', '502', 'network-error']).toContain(status);
        // 500（网关自身崩溃）不允许；502（上游拒绝/失败）是合法终态
        expect(status === '500').toBe(false);
      }
      await sleep(2_000);
      await keys.settleAll(userId);
      await keys.assertReconciled(userId, '1'); // 放行的都正确计费，拒绝的零扣
      // 大请求打真上游若触发连续失败会打开渠道熔断（5 分钟冷却）——清掉防连坐 ⑭
      await resetChannelHealth(fullGateway);
    }, 180_000);
  });

  describe('⑭ fixed=0.1 并发击穿验证', () => {
    // 上游重试失败会打开渠道熔断（共享 Redis 状态）——每例前复位保证起点干净；
    // 首例前写 KV 策略行并装配 fixed 网关（system_configs 热路径，网关首读即见）
    beforeEach(async () => {
      if (fixedGateway == null) {
        await setFixedReservationPolicy(world, '0.1');
        fixedGateway = await startE2EGateway(world);
      }
      await resetChannelHealth(fixedGateway);
    });

    it('余额 0.15 并发 8 路：至多 1-2 路放行（首路押尽可用额），其余 402；零击穿', async () => {
      world.upstream.script = 'nonstream-usage';
      const FUND = '0.15';
      const { raw, userId } = await keys.issue(FUND);
      const calls: Array<Promise<number>> = [];
      for (let i = 0; i < 8; i++) {
        calls.push(
          e2ePost(fixedGateway.baseUrl, raw, {
            // 大 max_tokens：保守估价 ≈0.168 > 余额 0.15，但 fixed 只冻结 0.1。
            model: floorModel,
            max_tokens: 20_000,
            messages: [{ role: 'user', content: '只回复：好' }],
          }).then(responseStatus),
        );
      }
      const results = await Promise.allSettled(calls);
      const statuses = results.map(settledStatus);
      const ok = statuses.filter(isOk200).length;
      const rejected = statuses.filter(is402).length;
      console.log(`⑭ 并发 8 路 → 放行 ${ok} / 402 ${rejected}（fixed 0.1，余额 ${FUND}）`);
      // 串行授权 + 固定冻结 0.1：首路冻结后可用 0.05 < 0.1，余 7 路必拒——
      // 确定性 1（断言 ≤1 无法检测 fixed 失效：full 模式 ok=0 也通过）
      expect(ok).toBe(1);
      expect(ok + rejected).toBe(8);

      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(ok); // 拒绝零落账
      const { balance } = await keys.assertReconciled(userId, FUND);
      expect(new Decimal(balance).gte('-0.01')).toBe(true); // 无击穿：不产生超出单笔的负债
    }, 240_000);

    it('单路大输出（max_tokens 20000）：最多负债 = 该笔真实用量（§4 上界内）', async () => {
      world.upstream.script = 'nonstream-usage';
      const FUND = '0.1';
      const { raw, userId } = await keys.issue(FUND);
      const res = await e2ePost(fixedGateway.baseUrl, raw, {
        model: floorModel,
        max_tokens: 20_000,
        messages: [{ role: 'user', content: '写一篇 500 字的短文，主题：海' }],
      });
      // 200（放行计费）或 502（上游超时三路归还）都是合法终态——两分支资金必须一致
      expect([200, 502]).toContain(res.status);
      await res.text().catch(swallow);

      await sleep(2_000);
      await keys.settleAll(userId);
      const { balance } = await keys.assertReconciled(userId, FUND);
      // 上界：input(小) + 20000×8.4/M ≈ 0.168+ ——负债不可能超过该笔真实用量
      console.log(
        `⑭ 大输出结算后余额 ${balance}（负债 ${new Decimal(FUND).minus(balance).abs().toString()}）`,
      );
      expect(new Decimal(balance).gte('-0.18')).toBe(true); // 单笔上界（20000 token 封顶）
      const bills14 = await keys.billsOf(userId);
      expect(bills14.length).toBe(1);
      expect(['settled', 'released']).toContain(defined(bills14[0], 'bills14[0]').status);
    }, 240_000);

    it('结算后连环放行：可用余额仍 ≥ fixed 即可再来——累计扣款恒等于真实用量', async () => {
      world.upstream.script = 'nonstream-usage';
      const FUND = '0.12';
      const { raw, userId } = await keys.issue(FUND);
      for (let round = 0; round < 3; round++) {
        const res = await e2ePost(fixedGateway.baseUrl, raw, {
          model: floorModel,
          max_tokens: 150,
          messages: [{ role: 'user', content: '只回复：好' }],
        });
        expect(res.status).toBe(200); // 每轮余额仍 ≥ 0.1 → 放行
        await res.text();
        await keys.settleAll(userId);
        const { balance } = await keys.assertReconciled(userId, FUND);
        expect(new Decimal(balance).gte('0.11')).toBe(true); // 小额实扣
        void balance;
      }
      // 3 轮总亏损 = Σ真实用量，余额仍在 floor 之上——薅不成羊毛
      const finalState = await keys.walletOf(userId);
      expect(new Decimal(finalState.balance).gt('0.118')).toBe(true);
    }, 300_000);
  });
});
