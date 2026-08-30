/**
 * 资金链完整性 e2e（admin 归组：依赖闭包需同时覆盖 gateway 与 admin-api 装配，
 * 经 apps/admin-api/node_modules 解析——identity 在 gateway 闭包之外）。
 *
 * 旅程形态（全真装配，替身只替换网络对端）：
 * - 隔离 schema 世界（gateway kit）+ 脚本化 mock 上游（usage 可精确预知）；
 * - admin-api 进程内全真装配挂同一世界——目录配置全部经 admin HTTP API 落库
 *   （provider → channel → model(价格) → 绑定），不 db 直插；
 * - 真实用户 key + 管理面真实充值动词（POST /v1/users/:id/adjust）入账；
 * - 网关全链流量三向量：非流式 / 流式 / 上游拒绝（零计费）；
 * - 金额断言全部 Decimal 精确比较；终态三重对账：
 *   用户守恒（余额 == 充值 − Σusage_logs）+ 复式账本（每交易 Σ腿=0、
 *   余额=末腿、credit/settle 腿分类守恒）+ 在途归零；
 * - 运行事实工件落盘（.artifacts/，gitignore——审计留证不入库）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { closeDb } from '@tillgate/db';
import { Decimal } from '@tillgate/billing';
import { assembleAdminApi, type AdminApiAssembly } from '../../apps/admin-api/src/assembly';
import { loadAdminApiConfig } from '../../apps/admin-api/src/config';
import { createAdminApp } from '../../apps/admin-api/src/app';
import { buildAdminAppOptions, defined } from './kit';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_REDIS_URL,
  E2E_UPSTREAM_KEY,
  E2E_URL,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from '../gateway/kit';

const hasEnv = E2E_URL !== undefined && E2E_URL !== '';

/** 断言目录价格（元/百万 token）——期望金额的独立计算口径 */
const PRICE_INPUT = '3.5';
const PRICE_OUTPUT = '12.75';
const PRICE_CACHE = '0.7';
const FUNDED = '200';
/** 按次计价模型的单位单价（元/次） */
const UNIT_PRICE = '0.8';

/** token 期望金额（元）= (in×input 价 + out×output 价) / 1e6 */
function expectedAmount(inputTokens: number, outputTokens: number): Decimal {
  return new Decimal(inputTokens)
    .mul(PRICE_INPUT)
    .plus(new Decimal(outputTokens).mul(PRICE_OUTPUT))
    .div('1000000');
}

interface UsageRow {
  input_tokens: string | number;
  output_tokens: string | number;
  cached_input_tokens: string | number;
  input_price: string;
  output_price: string;
  cache_input_price: string;
  amount: string;
  calculated_amount: string;
  coefficient: string;
}

describe.skipIf(!hasEnv)(
  'E2E 资金链完整性（admin API 建目录 → 真实用户全链 → 金额精确对账）',
  () => {
    const fcModel = `fc-pro-${randomUUID().slice(0, 8)}`;
    const fcReal = 'fc-real-pro';
    const fcUnitModel = `fc-unit-${randomUUID().slice(0, 8)}`;

    let world: E2EWorld;
    let gateway: E2EGateway;
    let keys: E2EKeys;
    let userId = 0;
    let rawKey = '';
    let adminAssembly: AdminApiAssembly;
    let adminServer: ServerType | null = null;
    let adminBase = '';
    let adminToken = '';

    /** 运行事实累积（终态落盘工件） */
    const facts: {
      generatedAt?: string;
      schema?: string;
      model?: string;
      seeding?: Record<string, unknown>;
      funded?: string;
      scenarios?: Array<Record<string, unknown>>;
      final?: Record<string, unknown>;
      ledger?: Array<Record<string, unknown>>;
      upstreamRecorded?: number;
      artifactPath?: string;
    } = {};

    beforeAll(async () => {
      world = await setupE2EWorld();
      gateway = await startE2EGateway(world);
      facts.schema = world.schema;
      facts.model = fcModel;

      // —— admin-api 进程内全真装配（同一隔离世界；渠道密钥与世界共钥可解）——
      const config = loadAdminApiConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        DATABASE_URL: world.scopedUrl,
        REDIS_URL: E2E_REDIS_URL ?? 'redis://:root123@127.0.0.1:6379',
        ADMIN_JWT_SECRET: 'e2e-fund-admin-jwt-secret-0123456789',
        JWT_SECRET: 'e2e-fund-user-jwt-secret-0123456789',
        ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
        IDENTITY_CODE_PEPPER: 'e2e-fund-pepper-0123456789',
        OTEL_TRACES_MODE: 'off',
      });
      adminAssembly = await assembleAdminApi(config);

      // 引导管理员行（create-admin 的核心插入，无密码面——直签 admin realm 会话）
      const adminRows = await world.db.execute<{ id: string | number }>(sql`
      insert into admins (email, display_name, role_id)
      select 'e2e-fund@tillgate.test', 'e2e-fund', id from roles where code = 'super_admin'
      returning id`);
      const adminId = Number(defined(adminRows[0], 'admin row').id);
      adminToken = await adminAssembly.identity.sessions.sign({
        realm: 'admin',
        subjectId: adminId,
        ttlSec: 600,
      });
      const adminApp = createAdminApp(buildAdminAppOptions(adminAssembly, config));
      adminServer = serve({ fetch: adminApp.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => {
        adminServer?.once('listening', resolve);
      });
      const address = adminServer.address();
      adminBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

      const adminCall = async (
        path: string,
        init: RequestInit = {},
      ): Promise<{ status: number; body: Record<string, unknown> }> => {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${adminToken}`);
        headers.set('content-type', 'application/json');
        const res = await fetch(`${adminBase}${path}`, { ...init, headers });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, body };
      };

      // —— 目录配置经 admin HTTP API 落库（网关 db 直读即时生效）——
      const provider = await adminCall('/v1/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: 'fund-chain-e2e',
          baseUrl: world.upstream.url,
          protocol: 'openai-compatible',
        }),
      });
      if (provider.status !== 201)
        throw new Error(`provider create failed: ${JSON.stringify(provider)}`);
      const providerId = Number(defined(provider.body.id, 'provider id'));

      const channel = await adminCall('/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          providerId,
          name: 'fund-chain-ch',
          apiKey: E2E_UPSTREAM_KEY,
          rpmLimit: 10_000,
        }),
      });
      if (channel.status !== 201)
        throw new Error(`channel create failed: ${JSON.stringify(channel)}`);
      const channelId = Number(defined(channel.body.id, 'channel id'));

      // 渠道进货（真实预算动词——余额 ≤0 会被路由硬闸拦截，必须经 API 充足预算）
      const recharge = await adminCall('/v1/channel-funds/recharge', {
        method: 'POST',
        body: JSON.stringify({ channelId, amount: '10000', remark: 'fund-chain e2e 进货' }),
      });
      if (recharge.status !== 200) {
        throw new Error(`channel recharge failed: ${JSON.stringify(recharge)}`);
      }

      const model = await adminCall('/v1/models', {
        method: 'POST',
        body: JSON.stringify({
          externalName: fcModel,
          realModel: fcReal,
          inputPrice: PRICE_INPUT,
          outputPrice: PRICE_OUTPUT,
          cacheInputPrice: PRICE_CACHE,
        }),
      });
      if (model.status !== 201) throw new Error(`model create failed: ${JSON.stringify(model)}`);
      const modelId = Number(defined(model.body.id, 'model id'));

      const bind = await adminCall(`/v1/models/${modelId}/channels`, {
        method: 'POST',
        body: JSON.stringify({
          channels: [{ channelId, upstreamModel: fcReal, weight: 3, priority: 2 }],
        }),
      });
      if (bind.status !== 200 || bind.body.ok !== true) {
        throw new Error(`model bind failed: ${JSON.stringify(bind)}`);
      }

      // 按次计价模型（token 价 0 + unitPrice 0.8）——单位计价资金向量
      const unitModel = await adminCall('/v1/models', {
        method: 'POST',
        body: JSON.stringify({
          externalName: fcUnitModel,
          realModel: fcReal,
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
          pricingUnit: 'request',
          unitPrice: UNIT_PRICE,
        }),
      });
      if (unitModel.status !== 201) {
        throw new Error(`unit model create failed: ${JSON.stringify(unitModel)}`);
      }
      const unitModelId = Number(defined(unitModel.body.id, 'unit model id'));
      const unitBind = await adminCall(`/v1/models/${unitModelId}/channels`, {
        method: 'POST',
        body: JSON.stringify({
          channels: [{ channelId, upstreamModel: fcReal, weight: 3, priority: 2 }],
        }),
      });
      if (unitBind.status !== 200 || unitBind.body.ok !== true) {
        throw new Error(`unit model bind failed: ${JSON.stringify(unitBind)}`);
      }
      facts.seeding = { providerId, channelId, modelId, unitModelId, bound: bind.body.bound };

      // —— 真实用户 + 管理面真实充值动词（非 facade 直调）——
      keys = new E2EKeys(world, gateway.assembly.billingFacade);
      const issued = await keys.issue('0');
      userId = issued.userId;
      rawKey = issued.raw;
      const adjust = await adminCall(`/v1/users/${userId}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount: FUNDED, remark: 'fund-chain e2e 充值' }),
      });
      if (adjust.status !== 200) throw new Error(`adjust failed: ${JSON.stringify(adjust)}`);
      facts.funded = FUNDED;
      facts.scenarios = [];
    }, 180_000);

    afterAll(async () => {
      if (adminServer != null) {
        await new Promise<void>((resolve) => {
          adminServer?.close(() => resolve());
        });
      }
      if (adminAssembly) await closeDb(adminAssembly.db);
      if (gateway) await gateway.stop();
      if (world) await world.teardown();
    });

    async function usageRows(): Promise<UsageRow[]> {
      const rows = await world.db.execute<UsageRow>(sql`
      select input_tokens, output_tokens, cached_input_tokens,
        input_price::text as input_price, output_price::text as output_price,
        cache_input_price::text as cache_input_price,
        amount::text as amount, calculated_amount::text as calculated_amount,
        coefficient::text as coefficient
      from usage_logs where user_id = ${userId} order by id`);
      return rows;
    }

    /** 等待 usage_logs 行数到位（流式收据落库是响应完成后的异步动作） */
    async function awaitUsageCount(count: number, timeoutMs = 10_000): Promise<UsageRow[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // 每轮顺带驱动结算：流式收据是响应完成后的异步落账，固定 sleep 后一次
        // settleAll 可能赶在收据置 settlement_pending 之前空转（负载下假红）
        await keys.settleAll(userId);
        const rows = await usageRows();
        if (rows.length >= count) return rows;
        if (Date.now() > deadline) {
          throw new Error(
            `usage rows not settled: want ${count}, got ${rows.length}: ${JSON.stringify(rows)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    function decEq(actual: string, expected: Decimal | string, label: string): void {
      if (!new Decimal(actual).eq(expected)) {
        throw new Error(`${label}: actual ${actual} != expected ${expected.toString()}`);
      }
    }

    it('① 非流式：上游 usage{10,5} → 按经 API 设置的价格精确计费', async () => {
      world.upstream.script = 'nonstream-usage';
      const res = await e2ePost(gateway.baseUrl, rawKey, {
        model: fcModel,
        messages: [{ role: 'user', content: '资金链① 非流式' }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      expect(body.usage?.prompt_tokens).toBe(10);
      expect(body.usage?.completion_tokens).toBe(5);

      await keys.settleAll(userId);
      const rows = await awaitUsageCount(1);
      const row = defined(rows[0], 'usage row ①');
      const expected = expectedAmount(10, 5);
      decEq(row.amount, expected, '① amount');
      decEq(row.calculated_amount, expected, '① calculated_amount');
      expect(Number(row.input_tokens)).toBe(10);
      expect(Number(row.output_tokens)).toBe(5);
      decEq(row.input_price, PRICE_INPUT, '① input_price 快照');
      decEq(row.output_price, PRICE_OUTPUT, '① output_price 快照');
      decEq(row.cache_input_price, PRICE_CACHE, '① cache_input_price 快照');
      decEq(row.coefficient, '1', '① coefficient');

      facts.scenarios?.push({
        scenario: 'nonstream',
        upstreamUsage: { prompt: 10, completion: 5 },
        expectedAmount: expected.toString(),
        actualAmount: row.amount,
        match: true,
      });
    });

    it('② 流式：终帧 usage{50,100} → 精确计费', async () => {
      world.upstream.script = 'stream-usage';
      const res = await e2ePost(gateway.baseUrl, rawKey, {
        model: fcModel,
        stream: true,
        messages: [{ role: 'user', content: '资金链② 流式' }],
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('[DONE]');

      // 流式 succeeded 信号在流结束后异步落账（装置口径同 slow.test ⑮b：先歇再结算）
      await sleep(2_000);
      await keys.settleAll(userId);
      const rows = await awaitUsageCount(2);
      const row = defined(rows[rows.length - 1], 'usage row ②');
      const expected = expectedAmount(50, 100);
      decEq(row.amount, expected, '② amount');
      decEq(row.calculated_amount, expected, '② calculated_amount');
      expect(Number(row.input_tokens)).toBe(50);
      expect(Number(row.output_tokens)).toBe(100);

      facts.scenarios?.push({
        scenario: 'stream',
        upstreamFinalUsage: { prompt: 50, completion: 100 },
        expectedAmount: expected.toString(),
        actualAmount: row.amount,
        match: true,
      });
    });

    it('③ 上游拒绝（400）→ 网关 5xx、零计费、usage_logs 不增行', async () => {
      const before = (await usageRows()).length;
      world.upstream.script = 'nonstream-reject';
      const res = await e2ePost(gateway.baseUrl, rawKey, {
        model: fcModel,
        messages: [{ role: 'user', content: '资金链③ 上游拒绝' }],
      });
      expect(res.status).toBe(400); // 上游 invalid_request 非可重试——错误面按 400 透传给调用方
      await res.text().catch(() => {});
      await keys.settleAll(userId);
      const after = (await usageRows()).length;
      expect(after).toBe(before);

      facts.scenarios?.push({
        scenario: 'upstream-reject',
        gatewayStatus: res.status,
        usageRowsAdded: after - before,
        charged: 0,
      });
    });

    it('④ 缓存命中：cached_tokens=4 → 未缓存/缓存/输出三段分价精确计费', async () => {
      world.upstream.script = 'nonstream-cached-usage';
      const res = await e2ePost(gateway.baseUrl, rawKey, {
        model: fcModel,
        messages: [{ role: 'user', content: '资金链④ 缓存命中' }],
      });
      expect(res.status).toBe(200);
      await keys.settleAll(userId);
      const rows = await awaitUsageCount(3);
      const row = defined(rows[rows.length - 1], 'usage row ④');
      // amount = (input−cached)×输入价 + cached×缓存价 + output×输出价（/1M）
      const expected = new Decimal(6)
        .mul(PRICE_INPUT)
        .plus(new Decimal(4).mul(PRICE_CACHE))
        .plus(new Decimal(5).mul(PRICE_OUTPUT))
        .div('1000000');
      decEq(row.amount, expected, '④ amount');
      decEq(row.calculated_amount, expected, '④ calculated_amount');
      expect(Number(row.input_tokens)).toBe(10);
      expect(Number(row.cached_input_tokens)).toBe(4);
      expect(Number(row.output_tokens)).toBe(5);

      facts.scenarios?.push({
        scenario: 'cached-tokens',
        upstreamUsage: { prompt: 10, cached: 4, completion: 5 },
        expectedAmount: expected.toString(),
        actualAmount: row.amount,
        match: true,
      });
    });

    it('⑤ 按次计价模型（pricingUnit=request）：每次请求固定 0.8 元', async () => {
      world.upstream.script = 'nonstream-usage';
      const res = await e2ePost(gateway.baseUrl, rawKey, {
        model: fcUnitModel,
        messages: [{ role: 'user', content: '资金链⑤ 按次' }],
      });
      expect(res.status).toBe(200);
      await keys.settleAll(userId);
      const rows = await awaitUsageCount(4);
      const row = defined(rows[rows.length - 1], 'usage row ⑤');
      decEq(row.amount, UNIT_PRICE, '⑤ amount');
      decEq(row.calculated_amount, UNIT_PRICE, '⑤ calculated_amount');
      const units = await world.db.execute<{ units: string | number; amount: string }>(sql`
        select units, amount::text as amount from usage_logs
        where user_id = ${userId} and external_model = ${fcUnitModel}`);
      const unitRow = defined(units[0], 'unit usage row');
      expect(Number(unitRow.units)).toBe(1);
      decEq(unitRow.amount, UNIT_PRICE, '⑤ units 行金额');

      facts.scenarios?.push({
        scenario: 'request-unit-pricing',
        pricingUnit: 'request',
        unitPrice: UNIT_PRICE,
        expectedAmount: UNIT_PRICE,
        actualAmount: unitRow.amount,
        units: 1,
        match: true,
      });
    });

    it('⑥ 终态三重对账：用户守恒 + 复式账本不变量 + 在途归零 → 工件落盘', async () => {
      await keys.settleAll(userId);
      const cachedExpected = new Decimal(6)
        .mul(PRICE_INPUT)
        .plus(new Decimal(4).mul(PRICE_CACHE))
        .plus(new Decimal(5).mul(PRICE_OUTPUT))
        .div('1000000');
      const totalCharged = expectedAmount(10, 5)
        .plus(expectedAmount(50, 100))
        .plus(cachedExpected)
        .plus(new Decimal(UNIT_PRICE));
      const reconciled = await keys.assertReconciled(userId, FUNDED);
      decEq(reconciled.charged, totalCharged, '⑥ Σusage');
      decEq(reconciled.balance, new Decimal(FUNDED).minus(totalCharged), '⑥ 终态余额');

      // 复式账本 1：全世界每笔交易 Σ有符号腿 == 0 且腿数 ≥ 2
      const badTx = await world.db.execute<{ tx: string; total: string; legs: number }>(sql`
      select l.transaction_id::text as tx, sum(l.amount)::text as total, count(*)::int as legs
      from wallet_legs l group by l.transaction_id
      having sum(l.amount) <> 0 or count(*) < 2`);
      expect(badTx).toHaveLength(0);

      // 复式账本 2：用户账户余额 == 末腿 balanceAfter，在途 == 0
      const accounts = await world.db.execute<{
        balance: string;
        in_flight: string;
        balance_after: string;
      }>(sql`
      select a.balance::text as balance, a.in_flight::text as in_flight,
        l.balance_after::text as balance_after
      from wallet_accounts a
      left join lateral (
        select balance_after from wallet_legs where account_id = a.id order by id desc limit 1
      ) l on true
      where a.kind = 'user'`);
      expect(accounts).toHaveLength(1);
      const account = defined(accounts[0], 'user wallet account');
      decEq(account.balance, account.balance_after, '⑥ 余额=末腿');
      decEq(account.in_flight, '0', '⑥ 在途归零');

      // 复式账本 3：用户账户腿分类守恒——credit Σ == 充值额，settle Σ == −Σ实扣
      const legsByKind = await world.db.execute<{ kind: string; total: string; legs: number }>(sql`
      select t.kind, sum(l.amount)::text as total, count(*)::int as legs
      from wallet_legs l
      join wallet_transactions t on t.id = l.transaction_id
      join wallet_accounts a on a.id = l.account_id
      where a.user_id = ${userId}
      group by t.kind`);
      const credit = legsByKind.find((r) => r.kind === 'credit');
      const settle = legsByKind.find((r) => r.kind === 'settle');
      decEq(defined(credit, 'credit legs').total, FUNDED, '⑥ credit 腿守恒');
      decEq(defined(settle, 'settle legs').total, totalCharged.neg(), '⑥ settle 腿守恒');

      // 上游留证：全部请求携带渠道密钥（①②③ 至少各一录）
      expect(world.upstream.recorded.length).toBeGreaterThanOrEqual(3);
      for (const r of world.upstream.recorded) {
        expect(r.headers.authorization).toBe(`Bearer ${E2E_UPSTREAM_KEY}`);
      }

      // 工件落盘（运行事实留证——目录 id、期望/实际金额、对账结论、账本腿）
      facts.generatedAt = new Date().toISOString();
      facts.final = {
        funded: FUNDED,
        charged: reconciled.charged,
        balance: reconciled.balance,
        inFlight: account.in_flight,
        doubleEntryTxsChecked: 'all-zero',
        creditLegsTotal: credit?.total,
        settleLegsTotal: settle?.total,
        reconciliation: 'balance == funded − Σusage_logs && in_flight == 0',
      };
      facts.ledger = legsByKind;
      facts.upstreamRecorded = world.upstream.recorded.length;
      const dir = new URL('./.artifacts/', import.meta.url).pathname;
      mkdirSync(dir, { recursive: true });
      const path = `${dir}fund-chain-${Date.now()}.json`;
      writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
      facts.artifactPath = path;
    });
  },
);
