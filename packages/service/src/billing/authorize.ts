/**
 * authorize 用例：授权预扣管线（资金来源瀑布形态）。
 *
 *   准入 → 金额推导（rating）→ 事务{
 *     advisory xact lock(user)（SUM 口径限额的并发串行化）
 *     → 每日限额 + 来源解析（凭证绑定的订阅与转按量开关——不信任传参）
 *     → planFunding ①：probe 循环定各源份额（订阅闸语义在 SubscriptionSource.probe；
 *       开关 OFF 覆盖不足 = 整单拒绝，ON = 订阅出余量 PAYG 补差）
 *     → INSERT billing_requests（requestId 幂等；重放=同指纹+同金额；
 *       投影三列从 plan 算出）
 *     → commitFunding ②：逐来源 reserve + billing_reservations 明细
 *       （免费快路径 0 元 = 空计划，不预留，账单行仅供观测）
 *   } → 回执（wallet 可用口径三数）
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type RepoContext } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import {
  BillingStateConflictError,
} from '@ai-gateway/domain';
import {
  assertDailySpendLimit,
  billingDayStart,
} from '@ai-gateway/domain';
import { calculateRequired } from '@ai-gateway/domain';
import type { BillingQuote } from '@ai-gateway/domain';
import { commandFingerprint, strictestBalanceFloor } from '@ai-gateway/domain';
import { Decimal, normalizeAmount } from '@ai-gateway/domain';
import type { FundingRegistry } from '../funding/registry.js';
import { commitFunding } from '../funding/commit.js';
import { planFunding } from '../funding/plan.js';
import type { WalletApi } from '../wallet/wallet.js';

export interface BillingEnv {
  db: Db;
  wallet: WalletApi;
  /** 计费币种（装配注入——资金规划与来源上下文的口径） */
  currency: string;
  /** 资金来源注册表（装配时创建注入；缺省 {subscription, payg}，§3.8） */
  fundingRegistry: FundingRegistry;
  clock?: () => Date;
  /** 仓储注入（缺省进程级默认实例） */
  repos?: Repositories;
  /** 结算积压准入（可选注入；抛 BillingBacklogError 关闸） */
  assertCapacity?: () => Promise<void>;
  /**
   * 结算唤醒（可选注入；signal 成功转入 settlement_pending 后调用，事务外）。
   * 纯「门铃」：失败不重试不阻断——丢失由 worker 兜底扫描覆盖。
   */
  wake?: (requestId: string) => void;
}

export interface AuthorizeBillingInput {
  requestId: string;
  userId: number;
  apiKeyId?: number | null;
  appId?: number | null;
  stream: boolean;
  quote: BillingQuote;
  reservationLimit: string;
  authorizationTtlMs: number;
  traceParent?: string | null;
}

export interface BillingAuthorization {
  requestId: string;
  /** 预估敞口（非冻结额）；结算按实扣 */
  reservedAmount: string;
  settledBalance: string;
  reservedBalance: string;
  availableBalance: string;
  replayed: boolean;
}

export function createAuthorizeUseCase(env: BillingEnv) {
  const { db, wallet, clock = () => new Date() } = env;
  const repos = env.repos ?? createRepositories();
  return async function authorize(
    ctx: RunContext,
    input: AuthorizeBillingInput,
  ): Promise<BillingAuthorization> {
    await env.assertCapacity?.();
    // 金额推导（保守预估）：每日限额与资金规划的输入口径；落账投影以 plan 实筹为准
    const amount = calculateRequired(input.quote, input.reservationLimit).toString();
    const fp = commandFingerprint('billing.authorize', {
      requestId: input.requestId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      stream: input.stream,
      quote: input.quote,
      amount,
    } as unknown as Parameters<typeof commandFingerprint>[1]);
    const now = clock();
    let fundedAmount = amount; // 全额路径缺省；floor 封顶路径在事务内覆写

    const replayed = await db.transaction(async (tx) => {
      const c = inTx(ctx, tx);
      // F4：每日限额是 SUM 口径，READ COMMITTED 看不见并发未提交行——按 user 串行化
      await repos.billingRequest.advisoryLockAuthorizeUser(c, input.userId);

      const source = await repos.credential.resolveSourceAndLimits(c, {
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        appId: input.appId ?? null,
      });

      // ---- 每日限额（已结算 + 在途 + 本次；重放排除自身请求防双计）----
      await assertDailyLimit(repos, c, {
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        userDailyLimit: source.userDailyLimit,
        keyDailyLimit: source.keyDailyLimit,
        amount,
        now,
      });

      // ---- 资金规划（两阶段①）：probe 循环定各源份额（不动账）----
      // 放行阈值 = 候选链最严 balanceFloor（预扣策略 billing_config.reservation；
      // 未声明 = null → 足额 fail-closed，现行语义）
      const plan = await planFunding(env.fundingRegistry, c, {
        userId: input.userId,
        requestId: input.requestId,
        currency: env.currency,
        credential: { apiKeyId: input.apiKeyId ?? null, appId: input.appId ?? null },
        resolved: {
          subscriptionId: source.subscriptionId,
          allowPaygFallback: source.allowPaygFallback,
        },
        amount,
        now,
        balanceFloor: strictestBalanceFloor(input.quote.candidates),
      });

      // ---- 落账（幂等重放）——投影三列从 plan 算出 ----
      // reserved_amount = 实际预占合计（Σ明细）。全额路径 == 保守预估；
      // balanceFloor 放行门封顶时 = 封顶实筹额——结算不变量「Σ明细==投影」
      // 结构性成立（否则 floor 单必死信、押金冻结——E2E ⑭ 抓获的真 bug）。
      fundedAmount = plan.entries.reduce((sum, entry) => sum.plus(entry.take), new Decimal(0)).toString();
      const inserted = await repos.billingRequest.insertAuthorized(c, {
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        appId: input.appId ?? null,
        reservedAmount: fundedAmount,
        planReservedAmount: plan.planReservedAmount,
        subscriptionId: source.subscriptionId,
        stream: input.stream,
        quote: input.quote as unknown as Record<string, unknown>,
        authorizationFingerprint: fp,
        traceParent: input.traceParent ?? null,
        leaseExpiresAt: new Date(now.getTime() + input.authorizationTtlMs),
        nextSettlementAt: now,
        createdAt: now,
      });
      if (!inserted) {
        const existing = await repos.billingRequest.findByRequestId(c, input.requestId);
        if (
          !existing ||
          existing.authorizationFingerprint !== fp ||
          existing.userId !== input.userId ||
          !new Decimal(existing.reservedAmount).eq(fundedAmount) ||
          // 重放只对未终态合法：已 settled/released/dead 的单据不得以 replayed 放行
          // （上游照调 → 结算必冲突 → 平台白付——未来任何重试编排接入前的防御位）
          (existing.status !== 'authorized' && existing.status !== 'in_flight')
        ) {
          throw new BillingStateConflictError(input.requestId, 'authorization replay conflict');
        }
        return true;
      }

      // ---- 资金预占（两阶段②）：逐来源 reserve + billing_reservations 明细 ----
      await commitFunding(c, repos, plan, { requestId: input.requestId, now });
      return false;
    });

    const summaries = await wallet.accounts(ctx, input.userId);
    const account = summaries[0];
    const settledBalance = account?.balance ?? '0';
    const reservedBalance = account?.inFlight ?? '0';
    const availableBalance = account
      ? new Decimal(account.balance).plus(account.creditLimit).minus(account.inFlight).toString()
      : '0';
    return {
      requestId: input.requestId,
      reservedAmount: normalizeAmount(fundedAmount),
      settledBalance,
      reservedBalance,
      availableBalance,
      replayed,
    };
  };
}

async function assertDailyLimit(
  repos: Repositories,
  c: RepoContext,
  input: {
    requestId: string;
    userId: number;
    apiKeyId: number | null;
    userDailyLimit: string | null;
    keyDailyLimit: string | null;
    amount: string;
    now: Date;
  },
): Promise<void> {
  const todayStart = billingDayStart(input.now);
  if (input.userDailyLimit != null) {
    const spent = await repos.usageLog.sumSettledSpend(c, { userId: input.userId, since: todayStart });
    const exposure = await repos.billingRequest.sumExposure(c, {
      userId: input.userId,
      excludeRequestId: input.requestId,
    });
    assertDailySpendLimit({
      scope: 'user',
      userId: input.userId,
      limit: input.userDailyLimit,
      spent,
      exposure,
      amount: input.amount,
    });
  }
  if (input.apiKeyId != null && input.keyDailyLimit != null) {
    const spent = await repos.usageLog.sumSettledSpend(c, {
      apiKeyId: input.apiKeyId,
      since: todayStart,
    });
    const exposure = await repos.billingRequest.sumExposure(c, {
      apiKeyId: input.apiKeyId,
      excludeRequestId: input.requestId,
    });
    assertDailySpendLimit({
      scope: 'key',
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      limit: input.keyDailyLimit,
      spent,
      exposure,
      amount: input.amount,
    });
  }
}
