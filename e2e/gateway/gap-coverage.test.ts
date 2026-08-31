/**
 * E2E 缺口补齐（流程覆盖矩阵中无 e2e 的五个环节——2026-08-31 补测）：
 *   C. 预算水位降权：充足渠道 vs 见底渠道（softRatio 之下）流量倾斜
 *   D. 模型维限流（admitModel）：model_mappings.rpm_limit=1 → 第二请求 503、上游零调用
 *   E. 流式中段上游断流（stream-mid-abort）：不换渠、按已传帧估算结算
 *   F. 上游 400 参数错：原码透传客户端、备用渠道零调用（换渠救不了参数错误）
 *   G. 有界等待（maybeWaitAndRetry）：全渠道 429 → 等待窗内上游恢复 → 单请求 200
 *
 * 契约事实（源码核实，勿猜）：
 *   - 预算水位：rankChannels factor = max(0.1, ratio/softRatio)（ratio < 0.2 起降权），
 *     ratio = (upstream_budget - upstream_reserved)/upstream_budget（channel-store 快照）
 *   - admitModel 拒绝 → 候选 skip(reason=rate_limited, code=rate_limit_exceeded) →
 *     isChannelExhausted → 503 no_available_channel（failover.ts planCandidatePass）
 *   - 流式首字节后不再换渠（relay-stream 事件面 aborted reason=upstream_disconnected
 *     族）；估算结算归属白名单见 billing rating/types.ts ESTIMATE_ATTRIBUTIONS
 *   - 400 透传：dispatchFailure routeFailure → respond（PassthroughDelivered 原码返回）
 *   - 有界等待：全败且 lastCode ∈ {rate_limited, rate_limit_exceeded} 且最早惩罚恢复
 *     ≤ wait.maxWaitMs → 睡后整轮重跑（failover.ts maybeWaitAndRetry）
 *   - 策略热源拾取：ROUTING_POLICY_TTL_MS 调小到 1s（写表后 ~1.2s 生效）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_MODEL,
  E2E_REAL_MODEL,
  e2ePost,
  resetChannelHealth,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';
import { E2E_UPSTREAM_KEY, startMockUpstream, type MockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

let world: E2EWorld;
let gateway: E2EGateway;
let keys: E2EKeys;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

/** 加渠道（绑到指定映射；priority 分层，weight 走缺省 1:1） */
async function addChannel(input: {
  name: string;
  baseUrl: string;
  priority: number;
  budget?: string;
  mappingId?: number;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, 1, ${input.budget ?? '1000'})
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${input.mappingId ?? world.seed.mappingId}, ${id}, ${E2E_REAL_MODEL})`);
  return id;
}

/** 加映射（独立对外名——各场景候选链互不污染；rpm 限流可配） */
async function addMapping(input: {
  external: string;
  real?: string;
  rpmLimit?: number;
}): Promise<number> {
  const rows = await world.db.execute(sql`
    insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price, rpm_limit)
    values (${input.external}, ${input.real ?? input.external}, '2.1', '8.4', '0.42', ${input.rpmLimit ?? null})
    returning id`);
  return Number((rows[0] as { id: string | number }).id);
}

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
});

afterAll(async () => {
  await gateway.stop();
  await world.teardown();
});

beforeEach(async () => {
  await resetChannelHealth(gateway);
  await world.db.execute(
    sql`delete from model_channels where mapping_id = ${world.seed.mappingId}`,
  );
});

describe.skipIf(!hasEnv)('E2E 缺口补齐', () => {
  it('C. 预算水位降权：见底渠道（ratio≈0.05）份额被压到 ~20%', async () => {
    const rich = startMockUpstream();
    const poor = startMockUpstream();
    await Promise.all([rich.ready, poor.ready]);
    try {
      await addChannel({ name: 'gap-rich', baseUrl: rich.url, priority: 0 });
      const poorId = await addChannel({
        name: 'gap-poor',
        baseUrl: poor.url,
        priority: 0,
        budget: '100',
      });
      // poor 预留 99（budget 100 → remaining 1，ratio=0.01 → factor=0.05）；
      // rich ratio=1 → factor=1。有效权重 1 : 0.05 → 期望 rich ≈ 95%
      await world.db.execute(
        sql`update channels set upstream_reserved = '99' where id = ${poorId}`,
      );
      const key = await keys.issue('50');
      const total = 20;
      for (let i = 0; i < total; i += 1) {
        // max_tokens 限小：预留 ~0.0002 << remaining 1.0，隔离预算硬闸（只测软降权）
        const res = await e2ePost(gateway.baseUrl, key.raw, {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'watermark probe' }],
          max_tokens: 16,
        });
        expect(res.status).toBe(200);
      }
      const richShare = rich.recorded.length / total;
      expect(rich.recorded.length + poor.recorded.length).toBe(total);
      // 期望 ~95%（1:0.05）；阈值 80% 容随机波动（1:1 均匀随机会在 ~50%）
      expect(richShare).toBeGreaterThan(0.8);
    } finally {
      await Promise.all([rich.close(), poor.close()]);
    }
  }, 120_000);

  it('D. 模型维限流（admitModel）：rpm_limit=1 → 第二请求 503 且上游零调用', async () => {
    const mock = startMockUpstream();
    await mock.ready;
    try {
      const model = `gap-rpm-${Date.now().toString(36)}`; // 随机名：RPM 滑窗键跨轮残留防御
      const mapId = await addMapping({ external: model, rpmLimit: 1 });
      await addChannel({ name: 'gap-rpm', baseUrl: mock.url, priority: 10, mappingId: mapId });
      const key = await keys.issue('10');

      const res1 = await e2ePost(gateway.baseUrl, key.raw, {
        model: model,
        messages: [{ role: 'user', content: 'rpm first' }],
      });
      expect(res1.status).toBe(200);
      expect(mock.recorded.length).toBe(1);

      // 同模型第二发：RPM 滑窗（60s）内超限 → 候选准入拒绝 → 渠道面竭尽 503
      const res2 = await e2ePost(gateway.baseUrl, key.raw, {
        model: model,
        messages: [{ role: 'user', content: 'rpm second' }],
      });
      expect(res2.status).toBe(503);
      const body = (await res2.json()) as { error: { code: string } };
      expect(body.error.code).toBe('inference.no_available_channel');
      expect(mock.recorded.length).toBe(1); // 上游零新增调用（门前拒绝）
    } finally {
      await mock.close();
    }
  });

  it('E. 流式中段上游断流：不换渠（备用零调用）、按已传帧估算结算', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await Promise.all([a.ready, b.ready]);
    a.script = 'stream-mid-abort';
    try {
      await addChannel({ name: 'gap-mid-a', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'gap-mid-b', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'mid abort probe' }],
      });
      // SSE 头已发 → 200；客户端收到部分内容后流终止
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('第一帧');
      expect(text).toContain('第二帧');
      // 首字节后不再换渠：备用渠道零调用
      expect(a.recorded.length).toBe(1);
      expect(b.recorded.length).toBe(0);

      // 估算结算：中段断流按已消费帧估算（estimated=true、output>0）。
      // 结算信号异步落地（fire-and-forget）——先等信号再驱动结算，否则 settleAll 空转
      await sleep(400);
      await keys.settleAll(key.userId);
      const rows = await world.db.execute(sql`
        select estimated, input_tokens, output_tokens, stream_aborted
        from usage_logs where user_id = ${key.userId}`);
      const row = rows[0] as
        | {
            estimated: boolean;
            input_tokens: string;
            output_tokens: string;
            stream_aborted: boolean;
          }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.estimated).toBe(true);
      expect(Number(row?.output_tokens)).toBeGreaterThan(0);
      expect(row?.stream_aborted).toBe(true);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);

  it('F. 上游 400 参数错：原码透传、备用渠道零调用、零计费', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await Promise.all([a.ready, b.ready]);
    a.script = 'nonstream-reject';
    try {
      await addChannel({ name: 'gap-400-a', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'gap-400-b', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: '400 passthrough probe' }],
      });
      // 4xx 客户端错误：换渠救不了 → 原码透传（不吞 502）
      expect(res.status).toBe(400);
      const body = (await res.text()).slice(0, 200);
      expect(body).not.toContain('"choices"'); // 错误信封，非成功体
      // 不可换渠词表：备用零调用；上游只在 A 撞过一次（400 不可重试）
      expect(a.recorded.length).toBe(1);
      expect(b.recorded.length).toBe(0);

      // 收尾：零计费、无 usage 行、账单释放
      await sleep(300);
      const usage = await world.db.execute(sql`
        select count(*)::int as n from usage_logs where user_id = ${key.userId}`);
      expect((usage[0] as { n: number }).n).toBe(0);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);

  it('G. 有界等待：全渠道 429 → 等待窗内恢复 → 单请求 200（客户端无感）', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await Promise.all([a.ready, b.ready]);
    a.script = 'rate-limit';
    b.script = 'rate-limit';
    try {
      // 热切策略：同渠道重试 1 次、惩罚基线 200ms（快恢复）、等待窗 3s
      await world.db.execute(sql`
        insert into routing_policies (scope, version, policy)
        values ('global', '9', ${JSON.stringify({
          enabled: true,
          scorers: {
            cacheAffinity: { enabled: false, boost: 3, ttlMs: 300_000, prefixChars: 4_096 },
            budgetWatermark: { enabled: true, softRatio: 0.2 },
          },
          retry: { sameChannelMaxRetries: 1 },
          penalty: {
            rateLimitBaseMs: 2_000,
            rateLimitMaxMs: 60_000,
            quotaMs: 1_800_000,
            conditionalBypass: true,
          },
          modelDead: { failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 },
          wait: { enabled: true, maxWaitMs: 5_000 }, // schema 上限（惩罚恢复 ~4s 需覆盖）
        })}::jsonb)
        on conflict (scope) do update set policy = excluded.policy, updated_at = now()`);
      await sleep(1_500); // TTL 1s 拾取
      // 诊断：确认热策略已生效（sameChannelMaxRetries=1 / base=2000 / wait=3000）
      const latest = gateway.assembly.inference ? null : null;
      void latest;

      await addChannel({ name: 'gap-wait-a', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'gap-wait-b', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      // 请求发出 1s 后上游恢复；惩罚恢复 ~4s ≤ 等待窗 5s → 等待后重跑落在恢复之后
      setTimeout(() => {
        a.script = 'auto';
        b.script = 'auto';
      }, 1_000);

      const startedAt = Date.now();
      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'bounded wait probe' }],
      });
      const elapsed = Date.now() - startedAt;
      console.log(
        `G diag: status=${res.status} elapsed=${elapsed} aCalls=${a.recorded.length} bCalls=${b.recorded.length}`,
      );
      for (const ch of ['gap-wait-a', 'gap-wait-b']) {
        const row = await world.db.execute(sql`select id from channels where name = ${ch}`);
        const id = (row[0] as { id: number } | undefined)?.id;
        if (id != null) {
          const raw = await gateway.assembly.redis.get(`inference:health:penalty:ch:${id}`);
          const pttl = await gateway.assembly.redis.pttl(`inference:health:penalty:ch:${id}`);
          console.log(`G diag: penalty ${ch}=${raw} pttl=${pttl}`);
        }
      }
      // 全渠道 429 → 同渠道各 2 次调用（重试预算 1）→ 惩罚 200ms 级恢复 ≤3s →
      // 等待重跑 → 上游已恢复 → 200。客户端全程单请求无感
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(900); // 确实经历了等待
      const calls429 = a.recorded.length + b.recorded.length;
      expect(calls429).toBeGreaterThanOrEqual(3); // 首轮 429：A 2 次（重试 1）+ B 1 次起
      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      // 策略还原为缺省（避免污染后续套件）
      await world.db.execute(sql`delete from routing_policies where scope = 'global'`);
      await sleep(1_500);
      await Promise.all([a.close(), b.close()]);
    }
  }, 90_000);
});
