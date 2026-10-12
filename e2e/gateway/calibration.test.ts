/**
 * E2E 收据校准三旅程（docs/calibrated-exposure-estimate.md §11）：
 *   旅程一：同前缀两笔 → 第二笔校准命中（prefix_calibrations 行 + quote.calibration
 *           字段 + channel_reserved_amount = 分段闭式 + conservative 非空）；
 *           改前缀第三笔 → 逐字段保守（回归锚）。
 *   旅程二：C7b 守卫（低报拒写）+ 超校准预留 ≤ 保守金额 → 超额扣减不死信。
 *   旅程三：B2 钳制边界绿灯（发票超字节界 → 钳定结算照常完成）。
 *
 * 闭式断言（非不等式——假绿对抗抽查点）；金额按 kit 价格快照
 * RX-M3（2.1/8.4/0.42）与 calibrationUsage 旋钮精确计算。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { billingRequests, prefixCalibrations, systemConfigs } from '@tillgate/db';
import {
  E2EKeys,
  E2E_INPUT_PRICE,
  E2E_MODEL,
  E2E_OUTPUT_PRICE,
  defined,
  e2ePost,
  resetChannelHealth,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

describe.skipIf(!hasEnv)('E2E 收据校准三旅程', () => {
  let world: E2EWorld;
  let gateway: E2EGateway;
  let keys: E2EKeys;
  let raw = '';

  beforeAll(async () => {
    world = await setupE2EWorld();
    gateway = await startE2EGateway(world);
    for (let i = 0; i < 50; i += 1) {
      if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
      await sleep(100);
    }
    // 渠道绑定成本五轴（与卖价同值——分段/保守金额的消费前提）
    await world.db.execute(sql`
      update model_channels set
        cost_input_price = ${'2.1'}, cost_output_price = ${'8.4'},
        cost_cache_input_price = ${'0.42'}, cost_cache_write_price = '0'
      where mapping_id = ${world.seed.mappingId}`);
    // 校准调参（D18 恒开——无开关字段；窗口 5min、ratio 0.9；TTL 15s 内拾取）
    const value = { window_ms: 300_000, cache_ratio: 0.9 };
    await world.db
      .insert(systemConfigs)
      .values({ key: 'billing_calibration', value })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value, updatedAt: new Date() },
      });
    await sleep(16_000); // TTL 过期拾取
    keys = new E2EKeys(world, gateway.assembly.billingFacade);
    await resetChannelHealth(gateway);
  });

  afterAll(async () => {
    await resetChannelHealth(gateway);
    await gateway.stop();
    await world.teardown();
  });

  const chat = (messages: Array<{ role: string; content: string }>) =>
    e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages,
      max_tokens: 1_000,
      stream: false,
    });

  it('部署兼容：PR #67 旧四参 KV 行经新解析器宽容生效（多余键忽略）', async () => {
    // 升级窗口语义（docs §3.3）：生产若存在旧四参行，window/ratio 照常生效
    const legacy = { enabled: false, window_ms: 240_000, cache_ratio: 0.8, user_side: false };
    await world.db
      .insert(systemConfigs)
      .values({ key: 'billing_calibration', value: legacy })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value: legacy, updatedAt: new Date() },
      });
    await sleep(16_000); // TTL 拾取
    const issued = await keys.issue('100');
    raw = issued.raw;
    world.upstream.script = 'nonstream-calibration';
    world.upstream.calibrationUsage = { promptTokens: 56_000, completionTokens: 185 };
    // 校准照常工作（旧 enabled:false 不再关停——D18 恒开），窗口 240s 足够命中
    const m1 = [{ role: 'user', content: 'q1'.repeat(110_000) }];
    const r1 = await chat(m1);
    expect(r1.status).toBe(200);
    await keys.settleAll(issued.userId);
    const rec = await world.db
      .select()
      .from(prefixCalibrations)
      .where(eq(prefixCalibrations.userId, issued.userId));
    expect(rec).toHaveLength(1); // 写入照常（恒开）
    // 宽容解析的真锁定：第二笔同前缀命中时快照携带旧行的调参值
    // （cacheRatio=0.8 来自旧四参行——若解析回落缺省会看到 0.9）
    const m2 = [...m1, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }];
    const r2 = await chat(m2);
    expect(r2.status).toBe(200);
    await keys.settleAll(issued.userId); // 结算第二笔后再对账（inFlight 清零）
    const hitRows = await world.db
      .select({ quote: billingRequests.quote })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    const hitQuote = (hitRows[0]?.quote as { calibration?: { cacheRatio?: number } }).calibration;
    expect(hitQuote?.cacheRatio).toBe(0.8); // 旧行 window/ratio 生效而非缺省
    await keys.assertReconciled(issued.userId, '100');
    // 还原规范二参调参供后续旅程
    const canonical = { window_ms: 300_000, cache_ratio: 0.9 };
    await world.db
      .update(systemConfigs)
      .set({ value: canonical })
      .where(eq(systemConfigs.key, 'billing_calibration'));
    await sleep(16_000);
  }, 120_000);

  it('旅程一：命中闭式 + 回落锚', async () => {
    const issued = await keys.issue('100');
    raw = issued.raw;
    world.upstream.script = 'nonstream-calibration';
    world.upstream.calibrationUsage = { promptTokens: 56_000, completionTokens: 185 };

    // 第一笔：写校准行（seen=50593, messagesLen=1；前缀 4k 字节 bytes/4=1k ≤ 50593 ✓）
    const m1 = [{ role: 'user', content: 'q1'.repeat(110_000) }]; // ~220KB：界 55k ≥ usage 50593（不钳、C7b ✓）
    const r1 = await chat(m1);
    expect(r1.status).toBe(200);
    await keys.settleAll(issued.userId);

    const calib = await world.db
      .select()
      .from(prefixCalibrations)
      .where(eq(prefixCalibrations.userId, issued.userId));
    expect(calib).toHaveLength(1);
    const record = defined(calib[0]);
    expect(record.inputTokens).toBe(56_000);
    expect(record.messagesLen).toBe(1);
    expect(record.channelId).toBe(world.seed.channelId);

    // 第二笔：只追加 → 命中（quote.calibration + 分段闭式 + conservative 非空）
    const m2 = [...m1, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }];
    const m2Body = { model: E2E_MODEL, messages: m2, max_tokens: 1_000, stream: false };
    const r2 = await e2ePost(gateway.baseUrl, raw, m2Body);
    expect(r2.status).toBe(200);
    const rows = await world.db
      .select({
        reserved: billingRequests.channelReservedAmount,
        conservative: billingRequests.conservativeChannelAmount,
        quote: billingRequests.quote,
      })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    const row = defined(rows[0]);
    const quote = row.quote as {
      calibration?: {
        inputTokens: number;
        messagesLen: number;
        cacheRatio: number;
        channelId: number;
      };
      candidates: Array<{ calibratedInputTokenUpperBound?: number }>;
    };
    expect(quote.calibration).toBeDefined();
    expect(quote.calibration).toMatchObject({
      inputTokens: 56_000,
      messagesLen: 3, // 前缀事实语义 = 本请求全链长（写入键；命中匹配在记录 len=1 处）
      cacheRatio: 0.9,
      channelId: world.seed.channelId,
    });
    // 分段闭式：cacheSeg=floor(56000×0.9)=50400×0.42/M；rest=(bound−50400)×2.1/M；out=1000×8.4/M
    const bound = defined(quote.candidates[0]?.calibratedInputTokenUpperBound);
    const expected = new Decimal(50_400)
      .times('0.42')
      .div(1_000_000)
      .plus(new Decimal(bound - 50_400).times(E2E_INPUT_PRICE).div(1_000_000))
      .plus(new Decimal(1_000).times(E2E_OUTPUT_PRICE).div(1_000_000));
    expect(new Decimal(defined(row.reserved)).eq(expected)).toBe(true);
    // conservative 闭式（P12c）：保守口径 = 全请求体字节界×2.1/M + 1000×8.4/M
    // （estimateMaxCost 的 estimatedInputTokens——不是校准界 bound）
    const bodyBytes = Buffer.byteLength(JSON.stringify(m2Body), 'utf8');
    const conservativeExpected = new Decimal(bodyBytes)
      .times(E2E_INPUT_PRICE)
      .div(1_000_000)
      .plus(new Decimal(1_000).times(E2E_OUTPUT_PRICE).div(1_000_000));
    expect(new Decimal(defined(row.conservative)).eq(conservativeExpected)).toBe(true);
    await keys.settleAll(issued.userId);
    await keys.assertReconciled(issued.userId, '100');

    // 第三笔：改前缀 → quote.calibration 缺失 + conservative NULL（保守预留）
    const edited = [{ role: 'user', content: 'EDITED'.repeat(110_000) }, ...m2.slice(1)];
    const r3 = await chat(edited);
    expect(r3.status).toBe(200);
    const fallback = await world.db
      .select({
        reserved: billingRequests.channelReservedAmount,
        conservative: billingRequests.conservativeChannelAmount,
        quote: billingRequests.quote,
      })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    const f = defined(fallback[0]);
    // 回落锚：quote.calibration = 前缀事实形态（channelId/inputTokens/cacheRatio 空
    // ——不进分段）；conservative NULL（B4 走原路径）
    const fcalib = (f.quote as { calibration?: { channelId: unknown; inputTokens: unknown } })
      .calibration;
    expect(fcalib).toMatchObject({ channelId: null, inputTokens: null });
    // 路 B#1：非校准预留也落保守值（列恒 = reserve 时点保守口径——topup/covered
    // 重入时 B4 ①③ 数值等价）；金额 = 保守口径（分段不适用）
    expect(f.conservative).not.toBeNull();
    expect(new Decimal(defined(f.reserved)).eq(new Decimal(defined(f.conservative)))).toBe(true);
    await keys.settleAll(issued.userId);
    await keys.assertReconciled(issued.userId, '100');
  });

  it('旅程二：C7b 拒写 + 超校准预留 ≤ 保守 → 超额扣减不死信', async () => {
    const issued = await keys.issue('100');
    raw = issued.raw;
    // 大前缀（400KB → bytes/4=100k > seen 60k → C7b 拒写——守卫的 e2e 验证）
    world.upstream.script = 'nonstream-calibration';
    const big = [{ role: 'user', content: 'x'.repeat(400_000) }];
    world.upstream.calibrationUsage = { promptTokens: 60_000, completionTokens: 100 };
    const r1 = await chat(big);
    expect(r1.status).toBe(200);
    await keys.settleAll(issued.userId);

    // 满足 C7b 的小前缀：200KB → bytes/4=50k ≤ seen 60k ✓ → 写记录
    const small = [{ role: 'user', content: 's'.repeat(200_000) }];
    const r1b = await chat(small);
    expect(r1b.status).toBe(200);
    await keys.settleAll(issued.userId);
    const rows1 = await world.db
      .select()
      .from(prefixCalibrations)
      .where(eq(prefixCalibrations.userId, issued.userId));
    expect(rows1).toHaveLength(1); // 只有 small 的记录（big 被 C7b 拒写）

    // 第二笔：命中（seen=60000）但实际 usage 90k——超分段 ≈0.05、≤ 保守 ≈0.297
    const small2 = [...small, { role: 'user', content: 't' }];
    world.upstream.calibrationUsage = { promptTokens: 90_000, completionTokens: 100 };
    const r2 = await chat(small2);
    expect(r2.status).toBe(200);
    // ② 触发证据（P12：不能只断 settled——miss 也会 settled）：
    // 预留=分段闭式（cacheSeg=floor(60000×0.9)=54000×0.42/M + rest×2.1/M + 100×8.4/M）
    // 且 conservative 非空（B4 ② 判定列在）
    const calibRows = await world.db
      .select({
        reserved: billingRequests.channelReservedAmount,
        conservative: billingRequests.conservativeChannelAmount,
        quote: billingRequests.quote,
      })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    const calibRow = defined(calibRows[0]);
    const calibBound = defined(
      (calibRow.quote as { candidates: Array<{ calibratedInputTokenUpperBound?: number }> })
        .candidates[0]?.calibratedInputTokenUpperBound,
    );
    const segExpected = new Decimal(54_000)
      .times('0.42')
      .div(1_000_000)
      .plus(new Decimal(calibBound - 54_000).times('2.1').div(1_000_000))
      .plus(new Decimal(1_000).times('8.4').div(1_000_000));
    expect(new Decimal(defined(calibRow.reserved)).lt(segExpected.plus('0.001'))).toBe(true);
    expect(calibRow.conservative).not.toBeNull();
    await keys.settleAll(issued.userId);

    const final = await world.db
      .select({ status: billingRequests.status, failureClass: billingRequests.failureClass })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    expect(defined(final[0]).status).toBe('settled'); // 超额扣减不死信
    await keys.assertReconciled(issued.userId, '100');
  });

  // 旅程三说明（P12b）：方案原定「超保守 → 死信」在 e2e 世界不可构造——
  // mock 收据价与 costPrices 同源（无价格漂移自由度），钳定后成本恒 ≤ 保守。
  // ③ 死信分支由 packages/billing calibration-settlement.test 分支③ 表驱动锁定；
  // e2e 本旅程锁 B2 钳制绿灯（校准值不进钳制的 I0 端到端证据）。
  it('旅程三：B2 钳制边界绿灯（发票超字节界 → 钳定结算照常完成）', async () => {
    const issued = await keys.issue('100');
    raw = issued.raw;
    world.upstream.script = 'nonstream-calibration';
    const prefix = [{ role: 'user', content: 'y'.repeat(100_000) }]; // 界 25k
    world.upstream.calibrationUsage = { promptTokens: 20_000, completionTokens: 50 };
    const r1 = await chat(prefix);
    expect(r1.status).toBe(200);
    await keys.settleAll(issued.userId);
    // 第二笔：发票 200k 超字节界 25k → B2 钳到 25k（钳定结算；钳制收据拒写校准行）
    const prefix2 = [...prefix, { role: 'user', content: 'z' }];
    world.upstream.calibrationUsage = { promptTokens: 200_000, completionTokens: 50 };
    const r2 = await chat(prefix2);
    expect(r2.status).toBe(200);
    await keys.settleAll(issued.userId);

    const rows = await world.db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.userId, issued.userId))
      .orderBy(sql`created_at desc`)
      .limit(1);
    expect(defined(rows[0]).status).toBe('settled'); // 钳定结算完成
    await keys.assertReconciled(issued.userId, '100');
  });
});
