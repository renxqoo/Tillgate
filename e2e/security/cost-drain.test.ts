/**
 * E2E 刷费用专项（v1 e2e-cost-drain 迁移；本地可控 mock 上游 + 真适配器 + 真计费全链）
 * ——「让用户无限刷平台上游费用」的每一个已知向量的闭环验证：
 *
 *   ① max_tokens 超口径声明 → 转发体被钳到预扣口径（预估敞口 ≥ 实际输出上限）
 *   ② 流式取消 + 无逐帧 usage → 输出 token 按累计内容估算收费（输出≠0——不
 *      估算则输出恒 0 = 「拉满输出再掐线」白嫖面）
 *   ③ 流式完成但上游不给 usage（忽略 include_usage 的供应商）→ 输出估算收费
 *   ④ 逐帧累计 usage 后取消 → 用最后一帧 usage 精确收费（不估算）
 *   ⑤ full 模式余额不足 → 402 整单拒绝（无预扣无上游调用）
 *   ⑥ fixed 低门槛放行 + 实际用量远超余额 → 实际全额补扣、形成负余额且不搁浅
 *   ⑦ 上游重试幂等键（Idempotency-Key = requestId）注入——防响应丢失重试双花上游
 *
 * v1 自建 pipeline 装配 → v2 全真装配（kit 世界；高价映射种子放大金额向量）。
 * 转发参数线名 v2 归一为 max_completion_tokens（装配面适配，语义不变）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import {
  defined,
  E2EKeys,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from '../gateway/kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

// ---------------------------------------------------------------------------
// 模块级辅助（describe×2 + it 已占 3 层回调——it 体内的箭头统一提为具名函数）
// ---------------------------------------------------------------------------

/** 吞取消/清理时的异常（fire-and-forget 清理口径） */
const swallow = (): void => {};

/** 读流超时哨兵（② 读流竞速——8s 无新帧视为 stall） */
function readStall(timeoutMs: number): Promise<never> {
  return new Promise((_, rej) => {
    setTimeout(() => rej(new Error('read-stall')), timeoutMs);
  });
}

describe.skipIf(!hasEnv)('E2E 刷费用专项', () => {
  let world: E2EWorld;
  let fullGateway: E2EGateway;
  let fixedGateway: E2EGateway;
  let keys: E2EKeys;
  /** 高价映射（放大金额向量）：input 60 / output 600 / cache 1（v1 同价） */
  let drainModel = '';

  beforeAll(async () => {
    world = await setupE2EWorld();
    fullGateway = await startE2EGateway(world);
    fixedGateway = await startE2EGateway(world, {
      BILLING_RESERVATION_MODE: 'fixed',
      BILLING_FIXED_RESERVATION_AMOUNT: '0.1',
    });
    keys = new E2EKeys(world, fullGateway.assembly.billingFacade);

    const external = `e2e-drain-${randomUUID().slice(0, 8)}`;
    await world.db.execute(sql`
      insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price)
      values (${external}, 'real-drain', '60', '600', '1')`);
    await world.db.execute(sql`
      insert into model_channels (mapping_id, channel_id, priority, weight)
      select id, ${world.seed.channelId}, 1, 1 from model_mappings where external_name = ${external}`);
    drainModel = external;
  }, 180_000);

  afterAll(async () => {
    if (fixedGateway) await fixedGateway.stop();
    if (fullGateway) await fullGateway.stop();
    if (world) await world.teardown();
  });

  async function latestReceipt(userId: number): Promise<{
    request_id: string;
    status: string;
    receipt: Record<string, unknown> | null;
    reserved_amount: string;
  }> {
    const rows = await world.db.execute<{
      request_id: string;
      status: string;
      receipt: Record<string, unknown> | null;
      reserved_amount: string;
    }>(
      sql`select request_id, status, reserved_amount, receipt from billing_requests where user_id = ${userId} order by created_at desc limit 1`,
    );
    return defined(rows[0], 'latest bill row');
  }

  /** 等待收据落库（流式终态信号是响应完成后的异步动作——不是同步可见） */
  async function awaitReceipt(
    userId: number,
    timeoutMs = 5_000,
  ): Promise<Awaited<ReturnType<typeof latestReceipt>>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const bill = await latestReceipt(userId);
      if (bill?.receipt != null) return bill;
      if (Date.now() > deadline) throw new Error(`receipt not persisted: ${JSON.stringify(bill)}`);
      await sleep(100);
    }
  }

  describe('上游对接硬边界', () => {
    it('① max_tokens 超口径声明（1,000,000）→ 转发体钳到 exposureCap（32,768）；n=4 按每路口径钳', async () => {
      world.upstream.script = 'nonstream-usage';
      const { raw } = await keys.issue('100');
      world.upstream.recorded.length = 0;

      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 1_000_000,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      await res.text();
      const upstreamBody = defined(world.upstream.recorded.at(-1), 'recorded upstream request')
        .body as {
        max_completion_tokens?: number;
        max_tokens?: number;
      };
      expect(upstreamBody.max_completion_tokens ?? upstreamBody.max_tokens).toBe(32_768); // 预扣口径（default 4096 × cap 32768 → 32768）

      // n=4：每路口径 = 32768/4
      world.upstream.recorded.length = 0;
      const res4 = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 1_000_000,
        n: 4,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res4.status).toBe(200);
      await res4.text();
      const upstreamBody4 = defined(world.upstream.recorded.at(-1), 'recorded upstream request')
        .body as {
        max_completion_tokens?: number;
        max_tokens?: number;
      };
      expect(upstreamBody4.max_completion_tokens ?? upstreamBody4.max_tokens).toBe(8_192);
    }, 60_000);

    it('⑦ 上游请求带 Idempotency-Key（= requestId）——重试不双花上游', async () => {
      world.upstream.script = 'nonstream-usage';
      const { raw } = await keys.issue('100');
      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(
        typeof defined(world.upstream.recorded.at(-1), 'recorded upstream request').headers[
          'idempotency-key'
        ],
      ).toBe('string');
    }, 30_000);

    it('⑤ full 模式余额不足 → 402 整单拒绝、零账单零上游调用', async () => {
      world.upstream.script = 'nonstream-usage';
      const { raw, userId } = await keys.issue('0.5');
      world.upstream.recorded.length = 0;
      // 高价模型 + 4096 输出上限的保守预估 ≈ ¥2.5+ >> 0.5 → 足额 fail-closed
      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 4_096,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(402);
      await res.text().catch(swallow);
      const bills = await world.db.execute(
        sql`select * from billing_requests where user_id = ${userId}`,
      );
      expect(bills.length).toBe(0);
      expect(world.upstream.recorded.length).toBe(0); // 上游一次都没被调——平台零损失
    }, 30_000);

    it('⑥ fixed=0.1 低门槛放行 + 实际用量远超余额 → 全额补扣负余额', async () => {
      world.upstream.script = 'nonstream-huge-usage'; // 实际 100k 输出 token × ¥600/M = ¥60 >> 预留 0.5
      const { raw, userId } = await keys.issue('0.5');

      const res = await e2ePost(fixedGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 4_096,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      await res.text();
      await keys.settleAll(userId);

      const bill = await latestReceipt(userId);
      expect(bill.status).toBe('settled'); // 不是 dead / 不是 settlement_pending 滞留
      // 实扣口径按真实 usage（60 元级）落 usage_logs；超出 0.1 的部分全部 #over 补扣。
      const usage = await world.db.execute<{ amount: string }>(
        sql`select amount::text from usage_logs where user_id = ${userId}`,
      );
      const usageAmount = defined(usage[0], 'usage row').amount;
      expect(new Decimal(usageAmount).gt(50)).toBe(true);
      const w = await keys.walletOf(userId);
      expect(new Decimal(w.balance).eq(new Decimal('0.5').minus(usageAmount))).toBe(true);
      expect(new Decimal(w.balance).lt(0)).toBe(true);
      expect(w.inFlight).toBe('0'); // 在途清零——无资金搁浅
    }, 60_000);
  });

  describe('流式计量闭环', () => {
    it('② 流式中途取消 + 上游无逐帧 usage → 输出按累计内容估算收费（≠0）', async () => {
      world.upstream.script = 'stream-no-usage-hold';
      const { raw, userId } = await keys.issue('100');

      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 4_096,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // 「拉满输出再掐线」攻击形态：读完全部 20 帧增量后断线（v2 relay 需求耦合，
      // 网关只累计已交付内容——装置适配：v1 读 1 帧时网关已主动累计全部帧）
      const reader = defined(res.body, 'stream body').getReader();
      const decoder = new TextDecoder();
      let text = '';
      // mock 恰发 20 个 delta 帧后挂住——按帧计数（TCP 合流时一次读可含多帧）
      while ((text.match(/"delta":\{"content"/g) ?? []).length < 20) {
        const { done, value } = await Promise.race([reader.read(), readStall(8_000)]);
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel('user abort').catch(swallow);
      await sleep(500);

      const bill = await awaitReceipt(userId);
      expect(bill.status).toBe('settlement_pending');
      const receipt = bill.receipt as unknown as {
        usage: { estimated: boolean; outputTokens: number; inputTokens: number };
        estimatedFor: string;
        streamAborted: boolean;
      };
      expect(receipt.usage.estimated).toBe(true);
      expect(receipt.estimatedFor).toBe('client_disconnect');
      expect(receipt.streamAborted).toBe(true);
      expect(receipt.usage.outputTokens).toBeGreaterThanOrEqual(100); // 200 个 CJK 字 ≈ 140 token（旧口径恒 0 = 白嫖面）

      await keys.settleAll(userId);
      const usage = await world.db.execute<{ amount: string }>(
        sql`select amount::text from usage_logs where user_id = ${userId}`,
      );
      // 输出估算量 × ¥600/M ≥ ¥0.08，加上输入费用——总扣费必须为正且显著
      expect(new Decimal(defined(usage[0], 'usage row').amount).gt('0.05')).toBe(true);
      const w = await keys.walletOf(userId);
      expect(w.inFlight).toBe('0');
    }, 60_000);

    it('③ 流式完成但上游不给 usage → 输出估算收费（usage_missing_completed ≠ 免单）', async () => {
      world.upstream.script = 'stream-done-no-usage';
      const { raw, userId } = await keys.issue('100');

      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 4_096,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      await res.text(); // 读完整个流（正常完成形态）

      const bill = await awaitReceipt(userId);
      const receipt = bill.receipt as unknown as {
        usage: { estimated: boolean; outputTokens: number };
        estimatedFor: string;
      };
      expect(receipt.usage.estimated).toBe(true);
      expect(receipt.estimatedFor).toBe('usage_missing_completed');
      expect(receipt.usage.outputTokens).toBeGreaterThanOrEqual(100);

      await keys.settleAll(userId);
      const usage = await world.db.execute<{ amount: string }>(
        sql`select amount::text from usage_logs where user_id = ${userId}`,
      );
      expect(new Decimal(defined(usage[0], 'usage row').amount).gt('0.05')).toBe(true);
      const w = await keys.walletOf(userId);
      expect(w.inFlight).toBe('0');
    }, 60_000);

    it('④ 逐帧累计 usage 后取消 → 最后一帧 usage 精确收费（不估算不白嫖）', async () => {
      world.upstream.script = 'stream-usage-hold';
      const { raw, userId } = await keys.issue('100');

      const res = await e2ePost(fullGateway.baseUrl, raw, {
        model: drainModel,
        max_tokens: 4_096,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      const reader = defined(res.body, 'stream body').getReader();
      await reader.read();
      await sleep(300); // 让若干累计帧流过
      await reader.cancel('user abort').catch(swallow);
      await sleep(500);

      const bill = await awaitReceipt(userId);
      const receipt = bill.receipt as unknown as {
        usage: { estimated: boolean; outputTokens: number; inputTokens: number };
      };
      expect(receipt.usage.estimated).toBe(false); // 累计 usage 是可信计量
      expect(receipt.usage.inputTokens).toBe(50);
      expect(receipt.usage.outputTokens).toBeGreaterThan(0);

      await keys.settleAll(userId);
      const usage = await world.db.execute<{ amount: string }>(
        sql`select amount::text from usage_logs where user_id = ${userId}`,
      );
      const expected = new Decimal(50)
        .times(60)
        .plus(new Decimal(receipt.usage.outputTokens).times(600))
        .div(1_000_000);
      expect(new Decimal(defined(usage[0], 'usage row').amount).eq(expected)).toBe(true); // 分毫=公式
      const w = await keys.walletOf(userId);
      expect(w.inFlight).toBe('0');
    }, 60_000);
  });
});
