/**
 * authorize 用例：授权预扣管线（资金来源瀑布形态）。
 *
 *   准入 → 金额推导（rating）→ 事务{
 *     advisory xact lock(user)（SUM 口径限额的并发串行化）
 *     → 每日限额 + 来源解析（凭证绑定的订阅与转按量开关——不信任传参）
 *     → planFunding ①：probe 循环定各源份额（订阅闸语义在 SubscriptionSource.probe；
 *       开关 OFF 覆盖不足 = 整单拒绝，ON = 订阅出余量 PAYG 补差）
 *     → INSERT billing_requests（requestId 幂等；重放=同指纹+同金额；投影三列从 plan 算出）
 *     → commitFunding ②：逐来源 reserve + billing_reservations 明细
 *       （免费快路径 0 元 = 空计划，不预留，账单行仅供观测）
 *   } → 回执（wallet 可用口径三数）
 */
import { BillingErrors } from '../../domain/errors.js';
import { calculateFundingReservation, calculateRequired } from '../../domain/rating/calculate.js';
import { assertDailySpendLimit } from '../../domain/billing/daily-limit.js';
import { billingDayStart } from '../../domain/billing/daily-window.js';
import { commandFingerprint } from '../../domain/fingerprint.js';
import type { FingerprintValue } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { Decimal } from '../../domain/money.js';
import type { BillingQuote } from '../../domain/rating/types.js';
import type { FundingReservationPolicy } from '../../domain/rating/calculate.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { FundingSourceResolver } from '../../ports/funding-ports.js';
import type { FundingRegistry } from './funding/registry.js';
import { commitFunding } from './funding/commit.js';
import { planFunding } from './funding/plan.js';
import type { WalletApi } from '../wallet/wallet.js';

export interface BillingEnv {
  store: BillingStore;
  resolver: FundingSourceResolver;
  /** 计费币种（装配注入——资金规划与来源上下文的口径） */
  currency: string;
  /** 资金来源注册表（装配时创建注入；缺省 {subscription, payg}） */
  fundingRegistry: FundingRegistry;
  wallet: WalletApi;
  /** 时钟（装配必填——零写死；钱包动词的 DB 时钟权威路径不经此） */
  clock: () => Date;
  /** 结算积压准入（可选注入；抛 settlement_backlog 关闸） */
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
  /** full=完整冻结；fixed=纯 PAYG 只冻结显式门槛，最终仍按实际全额收费。 */
  reservationPolicy?: FundingReservationPolicy;
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

// eslint-disable-next-line max-lines-per-function -- 计费授权事务体:重放快径→限额→资金源→投影,阶段共享 tx
export function createAuthorizeUseCase(env: BillingEnv) {
  const { store, wallet, clock } = env;
  // eslint-disable-next-line max-lines-per-function -- 计费授权事务体:重放快径→限额→资金源→投影,阶段共享 tx
  return async function authorize(input: AuthorizeBillingInput): Promise<BillingAuthorization> {
    // 金额推导（保守预估）：每日限额与资金规划的输入口径；落账投影以 plan 实筹为准
    const estimatedAmount = calculateRequired(input.quote, input.reservationLimit).toString();
    const reservationPolicy = input.reservationPolicy ?? { mode: 'full' as const };
    const fp = commandFingerprint('billing.authorize', {
      requestId: input.requestId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      appId: input.appId ?? null,
      stream: input.stream,
      quote: input.quote as unknown as Record<string, FingerprintValue>,
      estimatedAmount,
      reservationPolicy: reservationPolicy as Record<string, FingerprintValue>,
    });
    const now = clock();
    let fundedAmount = estimatedAmount;

    /** 已存在请求的快速路径：重放不应被新的积压、限额、余额或订阅状态误伤。 */
    const replayOf = (
      existing: Awaited<ReturnType<typeof store.findByRequestId>>,
    ): boolean | null => {
      if (!existing) return null;
      if (
        existing.authorizationFingerprint !== fp ||
        existing.userId !== input.userId ||
        (existing.status !== 'authorized' && existing.status !== 'in_flight')
      ) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          detail: 'authorization replay conflict',
        });
      }
      fundedAmount = existing.reservedAmount;
      return true;
    };

    const fastExisting = await store.read((conn) => store.findByRequestId(conn, input.requestId));
    let replayed = replayOf(fastExisting);

    if (!replayed) await env.assertCapacity?.();
    // eslint-disable-next-line max-lines-per-function -- 计费授权事务体:重放兜底分支,共享 fingerprint/限额中间量
    replayed ??= await store.transaction(async (tx) => {
      // resolver 是纯配置读（key/用户订阅绑定），不依赖并发互斥——事务首执行，
      // 移出串行区（快路径的串行窗口只剩 advisory[按需]+insert+资金门）。
      const source = await env.resolver.resolve(tx, {
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        appId: input.appId ?? null,
      });

      // F4：每日限额是 SUM 口径，READ COMMITTED 看不见并发未提交行——按 user 串行化。
      // 2026-08-26 快路径增量：串行按需——仅限额配置存在时取 advisory（SUM 口径需要），
      // 默认路径（限额全 NULL）跳过，同用户并发由钱包原子门（conditionalReserve）
      // 单语句串行。订阅 reserve（tryReserveQuota）自身条件安全，probe 过期由
      // 守卫输家干净回滚兜底。限额 NULL→设置 的配置瞬间可能漏判一次（非资损，落档）。
      const needsSerialization =
        source.userDailyLimit != null || source.keyDailyLimit != null;
      if (needsSerialization) {
        await store.advisoryLockAuthorizeUser(tx, input.userId);
      }

      // 与并发首请求在 advisory lock 汇合后的唯一冲突兜底重放（快路径无锁，
      // 由 insertAuthorized 唯一约束兜底——本读退化为便宜的双查）。
      const concurrentExisting = await store.findByRequestId(tx, input.requestId);
      if (replayOf(concurrentExisting)) return true;

      // ---- 每日限额（已结算 + 在途 + 本次；重放排除自身请求防双计）----
      await assertDailyLimit(store, tx, {
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        userDailyLimit: source.userDailyLimit,
        keyDailyLimit: source.keyDailyLimit,
        amount: estimatedAmount,
        now,
      });

      // fixed 首版只作用纯 PAYG。套餐仍完整预留，否则实际超出固定额的部分会被
      // 错误转扣钱包，而不是核销套餐额度。
      const fundingTarget =
        source.subscriptionId == null
          ? calculateFundingReservation(estimatedAmount, reservationPolicy).toString()
          : estimatedAmount;

      // ---- 资金规划（两阶段①）：probe 循环定各源份额（不动账）----
      const plan = await planFunding(env.fundingRegistry, tx, {
        userId: input.userId,
        requestId: input.requestId,
        currency: env.currency,
        credential: { apiKeyId: input.apiKeyId ?? null, appId: input.appId ?? null },
        resolved: {
          subscriptionId: source.subscriptionId,
          allowPaygFallback: source.allowPaygFallback,
        },
        amount: fundingTarget,
        now,
      });

      // ---- 落账（幂等重放）——风险预估与实际冻结分列 ----
      // reserved_amount = 实际预占合计（Σ明细）；estimated_exposure_amount = 完整保守预估。
      fundedAmount = plan.entries
        .reduce((sum, entry) => sum.plus(entry.take), new Decimal(0))
        .toString();
      const inserted = await store.insertAuthorized(tx, {
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        estimatedExposureAmount: estimatedAmount,
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
        const existing = await store.findByRequestId(tx, input.requestId);
        replayOf(existing);
        // 唯一冲突兜底重放:insert 失败意味着行已存在,缺行即状态冲突
        if (existing == null || !new Decimal(existing.reservedAmount).eq(fundedAmount)) {
          throw BillingErrors.business('state_conflict', {
            requestId: input.requestId,
            detail: 'authorization replay conflict',
          });
        }
        return true;
      }

      // ---- 资金预占（两阶段②）：逐来源 reserve + billing_reservations 明细 ----
      await commitFunding(store, tx, plan, { requestId: input.requestId, now });
      return false;
    });

    const summaries = await wallet.accounts(input.userId);
    const account = summaries.find((item) => item.currency === env.currency);
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
  store: BillingStore,
  conn: Parameters<BillingStore['sumExposure']>[0],
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
    const spent = await store.sumSettledSpend(conn, { userId: input.userId, since: todayStart });
    const exposure = await store.sumExposure(conn, {
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
    const spent = await store.sumSettledSpend(conn, {
      apiKeyId: input.apiKeyId,
      since: todayStart,
    });
    const exposure = await store.sumExposure(conn, {
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
