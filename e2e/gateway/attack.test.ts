/**
 * E2E 对抗套件（v1 e2e-attack 迁移；真网关 + 平台 key + mock 上游全链）——
 * 攻击 / 资损 / 漏扣 / 多扣 / 扣错全向量：
 *
 *   ⑤ 非法请求全家族（坏 key/坏体/未知模型/负参数/超大体/SQL 注入模型名）→ 全部零扣费
 *   ⑥ 伪造 x-request-id → 服务端 ID 独立（账单不混淆、不可固定绕过）
 *   ⑦ 非流式断连 → 单笔账单有始有终（不漏扣已产生输出）
 *   ⑧ 取消风暴（6 路并发流交错取消）→ 账单数 == 请求数、分毫对账
 *   ⑨ stream/非 stream 混合并发 → 收据旗标正确、usage 与 usage_logs 逐笔一致
 *   ⑩ n 倍数请求 → 计费覆盖全部输出；上游拒绝 → 释放不扣——两分支资金都一致
 *     （v1 依赖真上游二选一；mock 上游确定性覆盖两分支）
 *
 * 无法在本地确定性复现、由集成/单测层覆盖的向量（见文件尾覆盖矩阵）。
 * 断言语义与 v1 逐条等价（MIGRATION §7 验收）；装置差异（隔离 schema / mock 上游
 * /渠道 id 取种子值）见 kit 头注释。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import {
  defined,
  E2EKeys,
  E2E_MODEL,
  e2ePost,
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

/** 吞取消/断连清理时的异常（fire-and-forget 清理口径） */
const swallow = (): void => {};

/** 把异常折叠为 Error 值（⑤ 缺 messages 用例的失败形态断言用） */
const asError = (error: unknown): Error => error as Error;

/** 尝试结果 → 状态字符串（异常折叠为 'throw'——⑤ 家族断言口径） */
const attemptStatus = (a: Response | Error): string =>
  a instanceof Error ? 'throw' : String(a.status);

/** AbortController 批量构造（⑧ 取消风暴 6 路） */
const newController = (): AbortController => new AbortController();

/** 结局折叠为 ok/err 标记（⑧ 存活断言——拒绝也算有始有终） */
const asOk = (): 'ok' => 'ok';
const asErr = (): 'err' => 'err';
const outcome = (p: Promise<boolean>): Promise<'ok' | 'err'> => p.then(asOk, asErr);

const isOk = (s: string): boolean => s === 'ok';
const isStreamKind = (k: 'stream' | 'plain'): boolean => k === 'stream';
const isReleased = (b: { status: string }): boolean => b.status === 'released';

/** 账单收据的 stream 旗标（⑨ 收据旗标断言——收据形态与请求形态不串） */
const receiptStreamFlag = (b: { receipt: Record<string, unknown> | null }): boolean =>
  (b.receipt as { stream?: boolean } | null)?.stream === true;

/** 按 request_id 找 usage_log 行（⑨ 收据==日志逐笔一致断言） */
function findLogByRequestId(
  rows: Array<{ request_id: string; input_tokens: string; output_tokens: string }>,
  requestId: string,
): { request_id: string; input_tokens: string; output_tokens: string } | undefined {
  return rows.find((l) => l.request_id === requestId);
}

/** ⑧ 单路流式动作：启动 → 读首帧 → 交错延迟 → 取消（取消风暴的每一路） */
async function launchStreamJob(
  ctx: { baseUrl: string; raw: string },
  ac: AbortController,
  index: number,
): Promise<boolean> {
  const res = await e2ePost(
    ctx.baseUrl,
    ctx.raw,
    {
      model: E2E_MODEL,
      stream: true,
      max_tokens: 300,
      messages: [{ role: 'user', content: `从 1 慢慢数到 30（第 ${index} 批）` }],
    },
    ac.signal,
  );
  expect(res.status).toBe(200);
  const reader = defined(res.body, 'stream body').getReader();
  await reader.read(); // 至少一帧输出
  await sleep(150 * (index + 1)); // 交错取消点
  ac.abort();
  await reader.cancel().catch(swallow);
  return true;
}

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

  describe('对抗 · 非法请求全家族零扣费', () => {
    it('⑤ 坏 key 401 / 坏体 400 / 未知模型 404 / 负参数 400 / SQL 注入模型名 404 → 账单零落', async () => {
      world.upstream.script = 'nonstream-usage';
      const { raw, userId } = await keys.issue('1');

      const attempts = await Promise.all([
        e2ePost(gateway.baseUrl, 'sk_invalidinvalidinvalid', {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'x' }],
        }),
        e2ePost(gateway.baseUrl, raw, { model: E2E_MODEL }).catch(asError), // 缺 messages → 400
        e2ePost(gateway.baseUrl, raw, {
          model: `no-such-model-${randomUUID().slice(0, 6)}`,
          messages: [{ role: 'user', content: 'x' }],
        }),
        e2ePost(gateway.baseUrl, raw, {
          model: E2E_MODEL,
          max_tokens: -5,
          messages: [{ role: 'user', content: 'x' }],
        }),
        e2ePost(gateway.baseUrl, raw, {
          model: `RX-M3'; drop table users;--`,
          messages: [{ role: 'user', content: 'x' }],
        }),
      ]);
      const statuses = attempts.map(attemptStatus);
      expect(statuses[0]).toBe('401');
      expect(['400', 'throw']).toContain(statuses[1]);
      expect(statuses[2]).toBe('404');
      expect(statuses[3]).toBe('400');
      expect(statuses[4]).toBe('404'); // 注入串按「未知模型」处理，无副作用

      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(0); // 全家族零扣费（鉴权/校验失败不产生任何账单行）
      const walletState = await keys.walletOf(userId);
      expect(new Decimal(walletState.balance).eq('1')).toBe(true);
    }, 60_000);

    it('⑤b 超大请求体 413 → 零扣费', async () => {
      const { raw, userId } = await keys.issue('1');
      const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'A'.repeat(11 * 1024 * 1024) }],
        }), // 默认上限 10MiB
      });
      expect(res.status).toBe(413);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(0);
    }, 30_000);
  });

  describe('对抗 · 身份与幂等', () => {
    it('⑥ 伪造 x-request-id 连发 → 服务端各自生成：两笔独立账单不可混淆', async () => {
      world.upstream.script = 'nonstream-usage';
      const { raw, userId } = await keys.issue('1');
      const forged = randomUUID();
      const [a, b] = await Promise.all([
        fetch(`${gateway.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${raw}`,
            'content-type': 'application/json',
            'x-request-id': forged,
          },
          body: JSON.stringify({
            model: E2E_MODEL,
            max_tokens: 100,
            messages: [{ role: 'user', content: '只回复：一' }],
          }),
        }),
        fetch(`${gateway.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${raw}`,
            'content-type': 'application/json',
            'x-request-id': forged,
          },
          body: JSON.stringify({
            model: E2E_MODEL,
            max_tokens: 100,
            messages: [{ role: 'user', content: '只回复：二' }],
          }),
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
      world.upstream.script = 'nonstream-slow-body';
      const { raw, userId } = await keys.issue('1');
      const ac = new AbortController();
      const res = await e2ePost(
        gateway.baseUrl,
        raw,
        { model: E2E_MODEL, max_tokens: 200, messages: [{ role: 'user', content: '写 100 字' }] },
        ac.signal,
      );
      expect(res.status).toBe(200);
      ac.abort(); // 拿到响应头即断（不读体）
      await res.body?.cancel().catch(swallow);

      await sleep(2_000);
      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(1);
      expect(defined(bills[0], 'bills[0]').status).toBe('settled');
      await keys.assertReconciled(userId, '1'); // 分毫对账（断连不等于免费）
    }, 120_000);
  });

  describe('对抗 · 并发取消与混合负载', () => {
    it('⑧ 取消风暴：6 路并发流交错取消 → 恰 6 笔账单、分毫对账、在途归零', async () => {
      world.upstream.script = 'stream-usage-hold';
      const FUND = '1';
      const { raw, userId } = await keys.issue(FUND);
      const controllers = Array.from({ length: 6 }, newController);
      const launches: Array<Promise<boolean>> = [];
      for (const [i, ac] of controllers.entries()) {
        launches.push(launchStreamJob({ baseUrl: gateway.baseUrl, raw }, ac, i));
      }
      const survived = await Promise.all(launches.map(outcome));
      expect(survived.every(isOk)).toBe(true);

      await sleep(3_000); // 终态收敛
      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(6); // 每次取消恰一笔（不因取消产生额外/缺失账单）
      const reconciled = await keys.assertReconciled(userId, FUND);
      expect(new Decimal(reconciled.charged).gt(0)).toBe(true); // 已产生输出全部计费（不漏扣）
    }, 240_000);

    it('⑨ stream/非 stream 混合并发 4+4 → 旗标正确、收据 usage == usage_logs 逐笔一致', async () => {
      const FUND = '1';
      const { raw, userId } = await keys.issue(FUND);
      // auto 脚本按请求体 stream 分流（并发混合负载无共享脚本竞态）
      world.upstream.script = 'auto';
      const streamJob = async (): Promise<'stream' | 'plain'> => {
        const res = await e2ePost(gateway.baseUrl, raw, {
          model: E2E_MODEL,
          stream: true,
          max_tokens: 150,
          messages: [{ role: 'user', content: '只回复：流' }],
        });
        expect(res.status).toBe(200);
        await res.text();
        return 'stream';
      };
      const plainJob = async (): Promise<'stream' | 'plain'> => {
        const res = await e2ePost(gateway.baseUrl, raw, {
          model: E2E_MODEL,
          max_tokens: 150,
          messages: [{ role: 'user', content: '只回复：非流' }],
        });
        expect(res.status).toBe(200);
        await res.text();
        return 'plain';
      };
      const jobs: Array<Promise<'stream' | 'plain'>> = [];
      for (let i = 0; i < 4; i++) jobs.push(streamJob());
      for (let i = 0; i < 4; i++) jobs.push(plainJob());
      const kinds = await Promise.all(jobs);
      expect(kinds.filter(isStreamKind).length).toBe(4);

      await sleep(2_000);
      await keys.settleAll(userId);
      const bills = await keys.billsOf(userId);
      expect(bills.length).toBe(8);
      // 收据旗标与请求形态一致（不串）
      const streamFlags = bills.map(receiptStreamFlag);
      expect(streamFlags.filter(Boolean).length).toBe(4);
      // 逐笔一致：收据 token 与 usage_logs 行 token 完全相等（不多算不少算）
      const logs = await world.db.execute<{
        request_id: string;
        input_tokens: string;
        output_tokens: string;
      }>(
        sql`select request_id, input_tokens::text, output_tokens::text from usage_logs where user_id = ${userId}`,
      );
      expect(logs.length).toBe(8);
      for (const bill of bills) {
        const log = findLogByRequestId(logs, bill.request_id);
        expect(log).toBeDefined();
        const usage = (
          bill.receipt as { usage?: { inputTokens?: number; outputTokens?: number } } | null
        )?.usage;
        const matched = defined(log, 'usage_log row');
        expect(String(usage?.inputTokens ?? 0)).toBe(matched.input_tokens);
        expect(String(usage?.outputTokens ?? 0)).toBe(matched.output_tokens);
      }
      await keys.assertReconciled(userId, FUND);
    }, 240_000);

    it('⑩ n 倍数：上游接受 n → 计费覆盖全部输出；上游拒绝 → 释放不扣——两分支资金都一致', async () => {
      const FUND = '1';
      // 分支一：上游接受 n → 200 计费
      world.upstream.script = 'nonstream-usage';
      const first = await keys.issue(FUND);
      const res = await e2ePost(gateway.baseUrl, first.raw, {
        model: E2E_MODEL,
        max_tokens: 100,
        n: 3,
        messages: [{ role: 'user', content: '只回复：好' }],
      });
      expect(res.status).toBe(200);
      await res.text();
      await keys.settleAll(first.userId);
      const bills = await keys.billsOf(first.userId);
      expect(bills.length).toBe(1);
      expect(defined(bills[0], 'bills[0]').status).toBe('settled');
      await keys.assertReconciled(first.userId, FUND);

      // 分支二：上游拒绝 → 502 三路归还
      world.upstream.script = 'nonstream-reject';
      const second = await keys.issue(FUND);
      const rejected = await e2ePost(gateway.baseUrl, second.raw, {
        model: E2E_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: '只回复：好' }],
      });
      expect([400, 502]).toContain(rejected.status);
      await rejected.text();
      await sleep(1_500);
      const bills2 = await keys.billsOf(second.userId);
      expect(bills2.every(isReleased)).toBe(true);
      await keys.assertReconciled(second.userId, FUND); // 释放后 charged=0，余额==充值
    }, 120_000);
  });
});

/**
 * ┌ 覆盖矩阵：向量 → 测试落点 ┐
 * │ 漏扣-流式取消         → e2e ⑧ 取消风暴（6 笔全计费）+ ①（rxm3 real）
 * │ 漏扣-非流式断连       → e2e ⑦
 * │ 漏扣-上游失败         → e2e ⑩ 分支二（拒绝 → 释放不扣）
 * │ 多扣-取消重复计费     → e2e ⑦/⑧ 单笔断言 + double-fire 单测（inference）
 * │ 多扣-usage 放大/串账  → e2e ⑨ 收据==usage_logs 逐笔 + ⑫ 分毫对账（auth-audit）
 * │ 多扣-幂等键碰撞       → e2e ⑥ 伪造 x-request-id 独立两笔
 * │ 扣错-跨用户归属       → 集成归属测试（rxm3 real ④ 多用户大并发）
 * │ 资损-低余额并发放大   → e2e ⑭（params-floor：放行 ≤1/拒 7）+ 集成 §4
 * │ 攻击-爆破/刷 401      → 单测（production-hardening 两层防护）＊需 Redis 生产形态
 * │ 攻击-免费模型刷       → 单测 fail-closed（gate.test）＊同上
 * │ 攻击-SSRF/IP 伪造     → ai 包 http-client 单测 + http 包 trustedClientIp 7 例
 * │ 攻击-SQL 注入         → e2e ⑤ 注入模型名 404 零副作用 + 架构测试（SQL 只在 drizzle 层）
 * │ 攻击-超大体/负参数    → e2e ⑤/⑤b 400/413 零扣费
 * │ 资损-任务双结算       → 集成（generation-poll 并发 CAS 单赢家）
 * │ 资损-§4 超额推负      → e2e ⑥（cost-drain：fixed 超额补扣负余额）
 * └────────────────────────┘
 */
