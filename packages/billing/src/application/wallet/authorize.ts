/**
 * authorize 动词：冻结/预占——可用口径守卫（信用/现金双档）+ inFlight 占用。
 * 幂等快速路径在守卫之前（重放不该被余额守卫误伤）；跨用户键劫持 → ref_key_conflict。
 * 重放回执金额恒 normalizeAmount（首调与重放的字符串形态全等）。
 */
import { DefectError } from '@tillgate/errors';
import { assertCommandFingerprint, commandFingerprint } from '../../domain/fingerprint.js';
import type { FingerprintValue } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { parsePositiveAmount, toStorage } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import { assertCanDebit, guardKindOf } from '../../domain/wallet/exposure.js';
import type { AuthorizationSnapshot } from '../../domain/wallet/authorization.js';
import type { WalletConn, WalletStore } from '../../ports/wallet-store.js';
import { assertRefKey, resolveCurrency, type TxChannel } from './input.js';
import { withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

/** billing 授权域（#over 补扣的 refType 前提） */
export const BILLING_REF_TYPE = 'billing';

export interface AuthorizeInput extends TxChannel {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  /** 冻结单过期时刻（billing 语义下不用——生命周期归 billing 显式管理） */
  expiresAt?: Date;
  memo?: string;
  /** false = 现金口径守卫（授信不参与可用额）；缺省 = 信用口径 */
  allowCredit?: boolean;
  /**
   * 仅结算补扣内部使用：允许形成负余额。必须同时满足 billing refType 与 #over 自然键，
   * 普通授权调用无法借此绕过余额守卫。
   */
  collectOverage?: boolean;
}

export interface AuthorizeResult {
  authorizationId: string;
  amount: string;
  status: 'active' | 'settled' | 'released' | 'expired';
  expiresAt: string | null;
  replayed: boolean;
}

/** 幂等键归属校验：同 (refType, refId) 跨用户/币种顶撞必须炸，不能把别人的当自己的重放 */
// eslint-disable-next-line max-params -- 导出钱包动词:入参为稳定契约,改 options 触及全部调用方
async function assertAuthorizationOwner(
  store: WalletStore,
  conn: WalletConn,
  authorization: { accountId: string },
  refType: string,
  refId: string,
  userId: number,
  currency: string,
): Promise<void> {
  const owner = await store.accountOwner(conn, authorization.accountId);
  if (owner?.userId !== userId || owner?.currency !== currency) {
    throw BillingErrors.business('ref_key_conflict', {
      refType,
      refId,
      ownerUserId: owner?.userId ?? 0,
    });
  }
}

function authorizationResult(auth: AuthorizationSnapshot, replayed: boolean): AuthorizeResult {
  return {
    authorizationId: auth.id,
    amount: normalizeAmount(auth.amount),
    status: auth.status as AuthorizeResult['status'],
    expiresAt: auth.expiresAt ? auth.expiresAt.toISOString() : null,
    replayed,
  };
}

// eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
export function createAuthorizeUseCase(env: WalletEnv) {
  const { store, guards, currency: defaultCurrency } = env;
  // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
  return async function authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    const amount = parsePositiveAmount(input.amount);
    if (input.expiresAt && !(input.expiresAt instanceof Date)) {
      throw new DefectError('authorize.expiresAt', 'billing.wallet_invariant');
    }
    if (
      input.collectOverage === true &&
      (input.refType !== BILLING_REF_TYPE || !input.refId.endsWith('#over'))
    ) {
      throw new DefectError('authorize.collectOverage_scope', 'billing.wallet_invariant');
    }
    // 只在显式 false/true 时进指纹：缺省与反值语义等价（条件构造——严格指纹不收 undefined）
    const payload: Record<string, FingerprintValue> = {
      userId: input.userId,
      currency,
      amount: normalizeAmount(input.amount),
      expiresAt: input.expiresAt?.toISOString() ?? null,
      memo: input.memo ?? null,
    };
    if (input.allowCredit === false) payload.allowCredit = false;
    if (input.collectOverage === true) payload.collectOverage = true;
    const fingerprint = commandFingerprint('authorize', payload);

    // 幂等快速路径：守卫之前先查既有（重放不该被余额守卫误伤）
    const prior = await store.read((conn) =>
      store.findAuthorization(conn, input.refType, input.refId),
    );
    if (prior) {
      return store.read(async (conn) => {
        await assertAuthorizationOwner(
          store,
          conn,
          prior,
          input.refType,
          input.refId,
          input.userId,
          currency,
        );
        assertCommandFingerprint(prior.authorizeFingerprint, fingerprint, {
          refType: input.refType,
          refId: input.refId,
          kind: 'authorize',
        });
        return authorizationResult(prior, true);
      });
    }

    try {
      return await withTx(store, input.tx, async (tx) => {
        const accountId = await store.ensureUserAccount(tx, input.userId, currency);
        // 先插授权行:唯一约束是幂等的第一道闸(输家在 insert 即炸,事务回滚零副作用
        // ——in-memory store 无回滚也安全);守卫在后,输了同样整体回滚。
        const authorizationId = await store.insertAuthorization(tx, {
          accountId,
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount),
          expiresAt: input.expiresAt ?? null,
          memo: input.memo ?? null,
          authorizeFingerprint: fingerprint,
        });
        // 原子资金门(2026-08-26 快路径):守卫(可用额口径/active)进 WHERE 的单语句
        // 条件占用——行锁窗口 = 本语句→commit,同用户并发由本门串行(替代原
        // SELECT FOR UPDATE + 内存守卫 + setInFlight 三段);coherence 全 DEFERRED,
        // in_flight 与授权行的对账在 commit 统一校验,语句顺序自由。
        const reserved = await store.conditionalReserve(tx, {
          accountId,
          amount: toStorage(amount),
          guardKind: guardKindOf({ allowCredit: input.allowCredit }),
          collectOverage: input.collectOverage === true,
        });
        if (reserved == null) {
          // 守卫输:读快照分类报错(冻结/可用不足)——错误口径复用域守卫,单一真相
          const summaries = await store.userAccountSummaries(tx, input.userId);
          const account = summaries.find((row) => row.id === accountId);
          if (account == null) {
            throw new DefectError('authorize.account_missing', 'billing.wallet_invariant');
          }
          if (account.status === 'frozen') {
            throw BillingErrors.business('account_frozen', { accountId });
          }
          if (input.collectOverage !== true) {
            assertCanDebit(account, amount, input.userId, { allowCredit: input.allowCredit });
          }
          throw new DefectError('authorize.gate_unclassified', 'billing.wallet_invariant');
        }
        return {
          authorizationId,
          amount: normalizeAmount(input.amount),
          status: 'active' as const,
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          replayed: false,
        };
      });
    } catch (error) {
      if (store.isUniqueViolation(error)) {
        const existing = await store.read((conn) =>
          store.findAuthorization(conn, input.refType, input.refId),
        );
        if (existing) {
          return store.read(async (conn) => {
            await assertAuthorizationOwner(
              store,
              conn,
              existing,
              input.refType,
              input.refId,
              input.userId,
              currency,
            );
            assertCommandFingerprint(existing.authorizeFingerprint, fingerprint, {
              refType: input.refType,
              refId: input.refId,
              kind: 'authorize',
            });
            return authorizationResult(existing, true);
          });
        }
      }
      throw error;
    }
  };
}
