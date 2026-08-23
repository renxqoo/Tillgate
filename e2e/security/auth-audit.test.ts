/**
 * E2E ⑪ 认证绕过全家族 + ⑫ 全库数据审计（v1 e2e-auth-audit 迁移）：
 *   ⑪ 所有对外模型端点未带/带坏凭证一律 401（不可能绕过认证直调模型）；
 *      上游真实密钥在任何响应体/日志/账单 JSON 中零出现（解密值与密文都扫）。
 *   ⑫ 批量请求 + 结算后逐表审计：billing_requests（quote/receipt 快照字段）、
 *      billing_reservations（份额==预扣）、usage_logs（token/金额与收据逐笔相等、
 *      公式复核）、wallet（余额==充值−Σ实扣、流水 balance_before/after 连续、
 *      授权 settled==实扣）、request_logs（逐请求一行）、渠道预算 delta==Σ成本。
 * 断言语义与 v1 逐条等价；渠道/映射 id 取世界种子值（v1 dev 库硬编码 id 的装置适配）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tokenlens/billing';
import {
  E2E_INPUT_PRICE,
  E2E_MODEL,
  E2E_OUTPUT_PRICE,
  E2E_REAL_MODEL,
  E2EKeys,
  E2E_UPSTREAM_KEY,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from '../gateway/kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

describe.skipIf(!hasEnv)('E2E', () => {
  let world: E2EWorld;
  let gateway: E2EGateway;
  let keys: E2EKeys;

  beforeAll(async () => {
    world = await setupE2EWorld();
    gateway = await startE2EGateway(world);
    keys = new E2EKeys(world, gateway.assembly.billingFacade);
  }, 120_000);

  afterAll(async () => {
    if (gateway) await gateway.stop();
    if (world) await world.teardown();
  });

  describe('⑪ 认证绕过全家族', () => {
    const jsonEndpoints = [
      '/v1/chat/completions',
      '/v1/embeddings',
      '/v1/completions',
      '/v1/responses',
      '/v1/messages',
      '/v1/images/generations',
      '/v1/audio/speech',
      '/v1/rerank',
      '/v1/moderations',
      '/v1/video/generations',
      '/v1/music/generations',
    ];

    it('全部推理/任务端点：无凭证 → 401（一个都绕不过）', async () => {
      const results = await Promise.all(
        jsonEndpoints.map((path) =>
          fetch(`${gateway.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: E2E_MODEL, messages: [{ role: 'user', content: 'x' }] }),
          }).then((r) => r.status),
        ),
      );
      expect(results.every((s) => s === 401)).toBe(true);
    });

    it('模型目录与任务查询：无凭证 → 401；带坏凭证形态（Basic/裸串/JWT 样/空 Bearer）→ 401', async () => {
      const noAuth = await fetch(`${gateway.baseUrl}/v1/models`);
      expect(noAuth.status).toBe(401);
      const task = await fetch(`${gateway.baseUrl}/v1/videos/${randomUUID()}`);
      expect(task.status).toBe(401);

      const badForms: Array<Record<string, string>> = [
        { authorization: 'Basic dXNlcjpwYXNz' },
        { authorization: `Bearer ${randomUUID()}` }, // 非 ag_ 前缀（JWT 样）
        { authorization: 'Bearer ' },
        { authorization: 'ag_only_no_bearer' },
        { 'x-api-key': 'ag_whatever' }, // 错位置放 key 不算凭证
      ];
      // 逐形态直发网关（不注入有效凭证）
      const direct = await Promise.all(
        badForms.map((headers) =>
          fetch(`${gateway.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ model: E2E_MODEL, messages: [{ role: 'user', content: 'x' }] }),
          }).then((r) => r.status),
        ),
      );
      expect(direct.every((s) => s === 401)).toBe(true);
    });

    it('上游真实密钥零泄露：响应体 / request_logs / usage_logs / 账单 JSON 全扫（明文与密文）', async () => {
      world.upstream.script = 'auto';
      const { raw, userId } = await keys.issue('1');
      // 造一个 200（响应体取样）与一个 404（未知模型错误体取样）
      const okRes = await e2ePost(gateway.baseUrl, raw, {
        model: E2E_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: '只回复：好' }],
      });
      expect(okRes.status).toBe(200);
      const okBody = await okRes.text();
      const errRes = await e2ePost(gateway.baseUrl, raw, {
        model: `nope-${randomUUID().slice(0, 6)}`,
        messages: [{ role: 'user', content: 'x' }],
      });
      const errBody = await errRes.text();
      await keys.settleAll(userId);

      const haystacks = [okBody, errBody];
      // 日志与账单全量取样（该用户相关的每一行每一列的 JSON 文本化）
      const requestLogs = await world.db.execute(
        sql`select * from request_logs where user_id = ${userId}`,
      );
      const usageLogs = await world.db.execute(
        sql`select * from usage_logs where user_id = ${userId}`,
      );
      const bills = await world.db.execute(
        sql`select * from billing_requests where user_id = ${userId}`,
      );
      for (const rows of [requestLogs.rows, usageLogs.rows, bills.rows]) {
        haystacks.push(JSON.stringify(rows));
      }
      const enc = await world.db.execute<{ api_key_enc: string }>(
        sql`select api_key_enc from channels where id = ${world.seed.channelId}`,
      );
      for (const hay of haystacks) {
        expect(hay.includes(E2E_UPSTREAM_KEY)).toBe(false); // 明文密钥
        expect(hay.includes(enc.rows[0]!.api_key_enc)).toBe(false); // 密文也不出业务表
      }
    }, 120_000);
  });

  describe('⑫ 全库数据审计（落库正确性）', () => {
    it('2 非流 + 1 流请求结算后：七张表逐字段核对（快照/份额/公式/流水连续/预算 delta）', async () => {
      world.upstream.script = 'auto';
      const FUND = '1';
      const { raw, userId } = await keys.issue(FUND);
      const before = await world.db.execute<{ budget: string }>(
        sql`select upstream_budget::text as budget from channels where id = ${world.seed.channelId}`,
      );

      const [a, b] = await Promise.all([
        e2ePost(gateway.baseUrl, raw, {
          model: E2E_MODEL,
          max_tokens: 150,
          messages: [{ role: 'user', content: '只回复：甲' }],
        }),
        e2ePost(gateway.baseUrl, raw, {
          model: E2E_MODEL,
          max_tokens: 150,
          messages: [{ role: 'user', content: '只回复：乙' }],
        }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      await a.text();
      await b.text();
      const s = await e2ePost(gateway.baseUrl, raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 150,
        messages: [{ role: 'user', content: '只回复：丙' }],
      });
      expect(s.status).toBe(200);
      await s.text();

      await sleep(2_000);
      await keys.settleAll(userId);

      // ---- billing_requests：状态/快照字段/租约清理 ----
      const bills = await world.db.execute<{
        request_id: string;
        status: string;
        reserved_amount: string;
        channel_id: string;
        lease_expires_at: string | null;
        released_at: string | null;
        quote: { candidates: Array<Record<string, unknown>> };
        receipt: Record<string, unknown>;
      }>(
        sql`select request_id, status, reserved_amount, channel_id, lease_expires_at, released_at, quote, receipt from billing_requests where user_id = ${userId}`,
      );
      expect(bills.rows.length).toBe(3);
      for (const bill of bills.rows) {
        expect(bill.status).toBe('settled');
        expect(Number(bill.channel_id)).toBe(world.seed.channelId);
        expect(bill.lease_expires_at).toBeNull(); // 结算后租约清理
        expect(bill.released_at).toBeNull();
        const candidate = bill.quote.candidates[0]!;
        expect(candidate.mappingId).toBe(world.seed.mappingId); // 种子映射
        expect(candidate.externalModel).toBe(E2E_MODEL);
        expect(candidate.realModel).toBe(E2E_REAL_MODEL);
        expect(new Decimal(String(candidate.inputPrice)).eq(E2E_INPUT_PRICE)).toBe(true);
        expect(new Decimal(String(candidate.outputPrice)).eq(E2E_OUTPUT_PRICE)).toBe(true);
        const receipt = bill.receipt as unknown as {
          externalModel: string;
          realModel: string;
          channelId: string | null;
          coefficient: string;
          usage: {
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            estimated: boolean;
          };
          inputPrice: string;
          outputPrice: string;
        };
        expect(receipt.externalModel).toBe(E2E_MODEL);
        expect(receipt.realModel).toBe(E2E_REAL_MODEL);
        expect(Number(receipt.channelId)).toBe(world.seed.channelId);
        expect(receipt.coefficient).toBe('1'); // 无费率卡恒系数 1
        expect(new Decimal(receipt.inputPrice).eq(E2E_INPUT_PRICE)).toBe(true);
        expect(receipt.usage.estimated).toBe(false);
      }
      const streamCount = bills.rows.filter(
        (x) => (x.receipt as unknown as { stream: boolean }).stream === true,
      ).length;
      expect(streamCount).toBe(1); // 旗标与请求形态一一对应

      // ---- billing_reservations：份额合计 == 预扣、状态 settled ----
      const reservations = await world.db.execute<{
        billing_request_id: string;
        amount: string;
        status: string;
        source_type: string;
      }>(
        sql`select billing_request_id, amount::text, status, source_type from billing_reservations where billing_request_id = any(${sql.raw(`ARRAY[${bills.rows.map((row) => `'${row.request_id}'::uuid`).join(',')}]`)})`,
      );
      expect(reservations.rows.length).toBeGreaterThanOrEqual(3);
      for (const bill of bills.rows) {
        const own = reservations.rows.filter((r) => r.billing_request_id === bill.request_id);
        const sum = own.reduce((acc, r) => acc.plus(r.amount), new Decimal(0));
        expect(sum.eq(bill.reserved_amount)).toBe(true); // 明细合计==投影列
        expect(own.every((r) => r.status === 'settled' && r.source_type === 'payg')).toBe(true);
      }

      // ---- usage_logs：token 与收据逐笔相等；金额公式复核（cached 计价精确）----
      const usage = await world.db.execute<{
        request_id: string;
        input_tokens: string;
        cached_input_tokens: string;
        output_tokens: string;
        amount: string;
        input_price: string;
        output_price: string;
        cache_input_price: string;
        real_model: string;
        external_model: string;
        estimated: boolean;
        billed_by: string;
        duration_ms: string;
        units: string;
      }>(
        sql`select request_id, input_tokens::text, cached_input_tokens::text, output_tokens::text, amount::text, input_price::text, output_price::text, cache_input_price::text, real_model, external_model, estimated, billed_by, duration_ms::text, units::text from usage_logs where user_id = ${userId}`,
      );
      expect(usage.rows.length).toBe(3);
      for (const bill of bills.rows) {
        const log = usage.rows.find((u) => u.request_id === bill.request_id)!;
        const ru = (
          bill.receipt as unknown as {
            usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
          }
        ).usage;
        expect(log.input_tokens).toBe(String(ru.inputTokens));
        expect(log.cached_input_tokens).toBe(String(ru.cachedInputTokens));
        expect(log.output_tokens).toBe(String(ru.outputTokens));
        // 公式复核（以收据价格快照为锚——审计不写死任何价）：(uncached×input + cached×cache + output×output)/1M × 系数
        const snapshot = bill.receipt as unknown as {
          inputPrice: string;
          cacheInputPrice: string;
          outputPrice: string;
          coefficient: string;
        };
        const uncached = ru.inputTokens - ru.cachedInputTokens;
        const expected = new Decimal(uncached)
          .times(snapshot.inputPrice)
          .plus(new Decimal(ru.cachedInputTokens).times(snapshot.cacheInputPrice))
          .plus(new Decimal(ru.outputTokens).times(snapshot.outputPrice))
          .div(1_000_000)
          .times(snapshot.coefficient);
        expect(new Decimal(log.amount).eq(expected)).toBe(true);
        expect(log.real_model).toBe(E2E_REAL_MODEL);
        expect(log.external_model).toBe(E2E_MODEL);
        expect(log.estimated).toBe(false);
        expect(log.billed_by).toBe('payg');
        expect(Number(log.duration_ms)).toBeGreaterThan(0);
        expect(log.units).toBe('0');
      }

      // ---- wallet：余额对账 + 流水连续（balance_before/after 链）+ 授权 settled==实扣 ----
      const walletState = await keys.walletOf(userId);
      const charged = usage.rows.reduce((acc, u) => acc.plus(u.amount), new Decimal(0));
      expect(new Decimal(walletState.balance).eq(new Decimal(FUND).minus(charged))).toBe(true);
      expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);

      const account = await world.db.execute<{ id: string }>(
        sql`select id from wallet_accounts where user_id = ${userId} and kind = 'user'`,
      );
      const legs = await world.db.execute<{
        amount: string;
        balance_before: string;
        balance_after: string;
        ref_type: string;
      }>(
        sql`select l.amount::text, l.balance_before::text, l.balance_after::text, t.ref_type
            from wallet_legs l join wallet_transactions t on t.id = l.transaction_id
            where l.account_id = ${account.rows[0]!.id} order by l.id`,
      );
      expect(legs.rows.length).toBe(4); // 1 充值 + 3 结算
      expect(legs.rows[0]!.ref_type).toBe('topup');
      for (let i = 1; i < legs.rows.length; i++) {
        expect(new Decimal(legs.rows[i]!.balance_before).eq(legs.rows[i - 1]!.balance_after)).toBe(
          true,
        ); // 链式连续
        expect(legs.rows[i]!.ref_type).toBe('billing');
      }
      expect(new Decimal(legs.rows.at(-1)!.balance_after).eq(walletState.balance)).toBe(true); // 尾账==账户余额
      const settleSum = legs.rows
        .slice(1)
        .reduce((acc, l) => acc.plus(l.amount), new Decimal(0))
        .abs();
      expect(settleSum.eq(charged)).toBe(true); // 流水合计==usage_logs 合计

      const authorizations = await world.db.execute<{
        ref_id: string;
        amount: string;
        settled_amount: string;
        status: string;
      }>(
        sql`select wa.ref_id, wa.amount::text, wa.settled_amount::text, wa.status from wallet_authorizations wa
            join wallet_accounts acc on acc.id = wa.account_id where acc.user_id = ${userId} and wa.ref_type = 'billing' and wa.ref_id not like '%#over'`,
      );
      expect(authorizations.rows.length).toBe(3); // 每请求恰一条主授权（#over 超额另计）
      for (const authz of authorizations.rows) {
        expect(authz.status).toBe('settled');
        const bill = bills.rows.find((row) => row.request_id === authz.ref_id)!;
        expect(bill).toBeDefined();
        const log = usage.rows.find((u) => u.request_id === authz.ref_id)!;
        expect(new Decimal(authz.amount).eq(bill.reserved_amount)).toBe(true); // 授权额==预扣投影
        expect(new Decimal(authz.settled_amount).eq(log.amount)).toBe(true); // 实结==实扣
      }

      // ---- request_logs：每请求一行、状态码正确 ----
      const requestLogs = await world.db.execute<{
        request_id: string;
        status_code: string;
        path: string;
        method: string;
      }>(
        sql`select request_id, status_code::text, path, method from request_logs where user_id = ${userId}`,
      );
      expect(requestLogs.rows.length).toBe(3);
      for (const bill of bills.rows) {
        const rl = requestLogs.rows.find((r) => r.request_id === bill.request_id);
        expect(rl?.status_code).toBe('200');
        expect(rl?.path).toBe('/v1/chat/completions');
        expect(rl?.method).toBe('POST');
      }

      // ---- 渠道预算：delta == Σ上游成本（系数 1 → upstream_cost == amount）----
      const after = await world.db.execute<{ budget: string }>(
        sql`select upstream_budget::text as budget from channels where id = ${world.seed.channelId}`,
      );
      const delta = new Decimal(before.rows[0]!.budget).minus(after.rows[0]!.budget);
      expect(delta.eq(charged)).toBe(true); // 渠道进货扣减精确等于用户成本（系数 1 口径）

      console.log(
        `⑫ 审计通过：3 笔 Σ实扣 ${charged.toString()}，流水 ${legs.rows.length} 腿连续，预算 delta ${delta.toString()}`,
      );
    }, 240_000);
  });
});
